"""Bounded model-in-the-loop gait search, journaled in a local Terse actor."""
import hashlib
import json
import os
from pathlib import Path
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .actors import ROOT, TerseRuntime, encode
from .gallop import BOUNDS, VERSION, Gait, compact, evaluate, score


def api_key(dotenv=ROOT / '.env'):
    """Read only OPENAI_API_KEY; never source a shell file or forward to Bun."""
    key = os.environ.get('OPENAI_API_KEY')
    if not key and dotenv.exists():
        for line in dotenv.read_text().splitlines():
            match = re.fullmatch(r'\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*?)\s*', line)
            if match:
                key = match.group(1)
                if len(key) >= 2 and key[0] == key[-1] and key[0] in "\"'":
                    key = key[1:-1]
                break
    if not key or any(c.isspace() for c in key):
        raise ValueError('Set OPENAI_API_KEY in the environment or .env')
    return key


def object_schema(properties):
    return {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}


def candidate_tool():
    fields = {name: {'type': 'number', 'minimum': low, 'maximum': high} for name, (low, high) in BOUNDS.items()}
    fields['offsets'] = {'type': 'array', 'items': {'type': 'number', 'minimum': 0, 'maximum': .999},
                         'minItems': 4, 'maxItems': 4,
                         'description': 'FR, FL, RR, RL phase offsets; FR must be 0. Larger offsets land earlier.'}
    candidate = object_schema({'name': {'type': 'string'}, 'hypothesis': {'type': 'string'},
                               'gait': object_schema(fields)})
    return {'type': 'function', 'name': 'evaluate_gaits', 'strict': True,
            'description': 'Evaluate 3 coordinated parameter vectors in stock native MuJoCo; results appear next round.',
            'parameters': object_schema({'candidates': {'type': 'array', 'items': candidate, 'minItems': 3, 'maxItems': 3}})}


INSTRUCTIONS = """You design a coordinated quadruped gait by proposing parameters to a simulator.
Goal: repeated four-beat galloping with real aerial phases, stable posture, then forward speed.
This is a Go1 (12.74 kg), not an Ant. No external forces, welds, mass changes or force-limit changes.
Leg order FR,FL,RR,RL. phase=((t-.6)/period + offset)%1; swing when phase >= duty.
FR offset=0; larger offsets land earlier. Front and rear pair offsets must differ enough for actual
distinct touchdowns, while front/rear groups remain separated. The supplied seed is a symmetric bound.
MPC every .04s, 16-step horizon, fixed linear centroidal dynamics, friction pyramid mu=.4.
Tracks COM z=height-.02, zero roll/pitch/yaw, velocity vx ramped after .6s. MPC reference x starts
at current COM, y=0. sqrt diagonal cost: [5,40,zweight,velocityweight,10,5,300,pitchweight,100,2,2,2].
NNLS regularization is a residual coefficient (squared in cost). Forces converted via Jacobian to
stock position actuators: hip/thigh torque limit23.7Nm, calf35.55Nm, gains35. No force upper bound
in MPC, so saturation is measured. Stance IK torque=stance_kp*error-.5*velocity, swing IK gain45.
Swing target=COM+nominalFootOffset + baseVelocity*(swingDuration+.5*stanceDuration)
 + placement_gain*(baseVelocity-desiredVelocity); ground z=.020. Swing z uses clearance*sin(pi*u)^2.
Evaluation after 1.6s startup, 20ms contacts debounced for two samples. Four-beat cycles require all
four legs to land once per FR-to-FR cycle, front and rear groups adjacent in cyclic order, each
within-pair landing split >=20ms. Measured gallop requires >=3 such cycles, >=60% of complete cycles,
>=2 all-feet-air intervals of >=40ms, speed>.08m/s, no fall, height>.18m, tilt<25deg, yaw<20deg,
lateral displacement<.25m. Do not claim success from phase settings alone. Results on two seeds
are returned each round. Longer held-out tests decide promotion. Explore meaningful staggered
phases; keep some candidates near the best. Avoid duplicate vectors. Return 3 complete candidates
and a short physical hypothesis per candidate through evaluate_gaits. Do not emit arbitrary code.
"""


class OpenAIProposer:
    def __init__(self, model, key):
        self.model, self._key = model, key

    def propose(self, observation):
        # Stateless compact observations avoid an ever-growing hidden conversation.
        # Persist the response before trials so restarting never repeats a saved call.
        payload = {'model': self.model, 'instructions': INSTRUCTIONS,
                   'input': encode(observation), 'reasoning': {'effort': 'medium'},
                   'max_output_tokens': 6000, 'store': False,
                   'tools': [candidate_tool()], 'parallel_tool_calls': False,
                   'tool_choice': {'type': 'function', 'name': 'evaluate_gaits'}}
        result = self.request(payload)
        calls = [item for item in result.get('output', [])
                 if item.get('type') == 'function_call' and item.get('name') == 'evaluate_gaits']
        if result.get('status') != 'completed' or len(calls) != 1:
            raise RuntimeError(f"OpenAI response did not complete one candidate call (status={result.get('status')})")
        candidates = json.loads(calls[0]['arguments'])['candidates']
        if len(candidates) != 3:
            raise ValueError('Expected exactly 3 candidates')
        for candidate in candidates:
            Gait(**candidate['gait'])
        return {'response_id': result['id'], 'model': result['model'], 'usage': result.get('usage', {}),
                'candidates': candidates}

    def request(self, payload):
        request = Request('https://api.openai.com/v1/responses', data=encode(payload).encode(),
                          headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {self._key}'})
        try:
            with urlopen(request, timeout=240) as response:
                result = json.load(response)
        except HTTPError as error:
            # Provider errors can quote rejected credentials: redact before reporting.
            try:
                message = json.load(error).get('error', {}).get('message', 'request rejected')
                message = str(message).replace(self._key, '[redacted]')
                message = re.sub(r'sk-[A-Za-z0-9_\-]+', '[redacted]', message)
            except (ValueError, AttributeError):
                message = 'request rejected'
            finally:
                error.close()
            raise RuntimeError(f'OpenAI HTTP {error.code}: {message[:500]}') from None
        except (URLError, TimeoutError, OSError):
            raise RuntimeError('OpenAI network request failed; completed responses/trials remain in Terse') from None
        return result


class Journal:
    def __init__(self, runtime, run_id):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,60}', run_id):
            raise ValueError('Run ID must contain 1–60 letters, digits, underscores or hyphens')
        self.runtime, self.run_id = runtime, run_id
        self.entries = {key: json.loads(value) for key, value in runtime.call('GaitSearch', run_id, 'inspect').items()}

    def put(self, key, value):
        value = self.runtime.call('GaitSearch', self.run_id, 'put', key, encode(value))
        self.entries[key] = value
        return value

    def trial(self, gait, seconds, seed, output):
        identity = encode({'version': VERSION, 'gait': gait.to_dict(), 'seconds': seconds, 'seed': seed})
        trial_id = 'trial-' + hashlib.sha256(identity.encode()).hexdigest()[:24]
        if trial_id not in self.entries:
            result = evaluate(gait, seconds, seed, trace_path=output / f'{trial_id}.npz')
            self.put(trial_id, result)
            print(encode({'trial': trial_id, **compact(result)}), flush=True)
        return self.entries[trial_id]

    def export(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.entries, indent=2) + '\n')
        temporary.replace(path)


def run_search(output, run_id='gallop-v1', model='gpt-6-astra', rounds=6):
    if not 1 <= rounds <= 12:
        raise ValueError('Use 1–12 total model rounds per invocation')
    key = api_key()
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    runtime = TerseRuntime(port=0, data_dir=output / 'terse')
    journal = None
    try:
        runtime.start()
        journal = Journal(runtime, run_id)
        journal.put('config', {'controller': VERSION, 'model': model, 'train_seeds': [0, 1],
                               'train_seconds': 6., 'validation_seeds': [101, 102, 103], 'validation_seconds': 20.})
        baseline = Gait()
        baseline_results = [journal.trial(baseline, 6., seed, output) for seed in (0, 1)]
        history = [{'name': 'hand-tuned-bound', 'gait': baseline.to_dict(),
                    'results': [compact(r) for r in baseline_results], 'score': score(baseline_results)}]
        proposer = OpenAIProposer(model, key)
        for round_index in range(rounds):
            key_name = f'round-{round_index:02}'
            response = journal.entries.get(key_name)
            if response is None:
                print(f'Model round {round_index + 1}/{rounds}: proposing three candidates', flush=True)
                response = proposer.propose({'round': round_index + 1, 'total_rounds': rounds, 'history': history})
                journal.put(key_name, response)
                journal.export(output / 'journal.json')
            for candidate in response['candidates']:
                gait = Gait(**candidate['gait'])
                results = [journal.trial(gait, 6., seed, output) for seed in (0, 1)]
                history.append({**candidate, 'results': [compact(r) for r in results], 'score': score(results)})
            journal.export(output / 'journal.json')
            print(encode({'round_completed': round_index + 1, 'best': max(history, key=lambda c: c['score'])}), flush=True)
        # Validate the two best distinct model policies plus the hand-tuned bound.
        finalists = []
        seen = set()
        for candidate in sorted(history[1:], key=lambda c: c['score'], reverse=True):
            identity = encode(Gait(**candidate['gait']).to_dict())
            if identity not in seen:
                seen.add(identity)
                finalists.append(candidate)
            if len(finalists) == 2:
                break
        finalists.append(history[0])
        validation = []
        for candidate in finalists:
            print(f"Validating {candidate['name']}: three held-out 20-second trials", flush=True)
            results = [journal.trial(Gait(**candidate['gait']), 20., seed, output) for seed in (101, 102, 103)]
            validation.append({'name': candidate['name'], 'gait': candidate['gait'], 'score': score(results),
                               'results': [compact(r) for r in results]})
        best = max(validation, key=lambda c: c['score'])
        report = {'run_id': run_id, 'model': model, 'rounds': rounds,
                  'measured_gallop': all(r['measured_gallop'] for r in best['results']),
                  'best': best, 'validation': validation,
                  'usage': {key: sum(v.get('usage', {}).get(key, 0) for k, v in journal.entries.items() if k.startswith('round-'))
                            for key in ('input_tokens', 'output_tokens', 'total_tokens')}}
        journal.put(f'report-{rounds:02}', report)
        (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        (output / 'best-policy.json').write_text(json.dumps(best['gait'], indent=2) + '\n')
        print(encode(report), flush=True)
        return report
    finally:
        if journal:
            journal.export(output / 'journal.json')
        runtime.stop()
