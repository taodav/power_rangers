import json

import numpy as np
import pytest

from power_rangers.gallop import Gait, PeriodicController, contact_metrics, evaluate, score
from power_rangers.gait_search import Journal, OpenAIProposer, api_key
from power_rangers.simulation import Simulation


@pytest.mark.parametrize('params', [dict(period=float('nan')), dict(vx=1), dict(duty=True),
                                    dict(offsets=[0, 0, .5]), dict(offsets=[.1, 0, .5, .5]),
                                    dict(offsets=[0, 0, float('inf'), .5])])
def test_model_parameters_cannot_escape_controller_limits(params):
    with pytest.raises(ValueError):
        Gait(**params)


def synthetic_contacts(stagger):
    times = np.arange(0, 6, .02)
    # Front then rear, with an actual aerial interval between groups.
    landings = np.array([.30, .30 + stagger, 0, stagger])
    contacts = ((times[:, None] - landings) % .5) < .12
    return times, contacts


def test_measured_contacts_distinguish_bound_and_gallop():
    bound = contact_metrics(*synthetic_contacts(0), .5)
    gallop = contact_metrics(*synthetic_contacts(.06), .5)
    assert bound['four_beat_cycles'] == 0
    assert gallop['four_beat_cycles'] >= 6
    assert gallop['four_beat_fraction'] == 1
    assert gallop['flight_intervals'] >= 6
    assert .1 <= gallop['longest_flight_s'] <= .14


def test_single_sample_contact_noise_is_not_a_touchdown():
    times = np.arange(0, 3, .02)
    contacts = np.zeros((len(times), 4), dtype=bool)
    contacts[100] = True
    result = contact_metrics(times, contacts, .5)
    assert result['complete_cycles'] == 0
    assert all(not edges for edges in result['touchdowns'].values())


def test_executor_keeps_stock_physics_and_reproduces_rollout():
    sim = Simulation(rig=False)
    force_limits = sim.model.actuator_forcerange.copy()
    masses = sim.model.body_mass.copy()
    controller = PeriodicController(sim, Gait(offsets=(0, .1, .5, .6)))
    for _ in range(100):
        controller.step()
    assert sim.tick == 100 and sim.data.time == pytest.approx(2.)
    assert not sim.data.eq_active.any() and not sim.data.xfrc_applied.any()
    assert np.array_equal(sim.model.actuator_forcerange, force_limits)
    assert np.array_equal(sim.model.body_mass, masses)
    first, second = evaluate(Gait(), 2., 7), evaluate(Gait(), 2., 7)
    assert first == second
    assert first['failure'] is None


def test_ranking_rejects_fast_falls():
    common = dict(elapsed_s=6., requested_s=6., four_beat_fraction=.8,
                  measured_gallop=True, max_tilt_deg=10., speed_m_s=.2, healthy=True)
    assert score([common]) > score([{**common, 'healthy': False, 'speed_m_s': 4.}])
    assert score([common]) > score([{**common, 'measured_gallop': False, 'four_beat_fraction': 0., 'speed_m_s': .3}])


def test_dotenv_reads_key_without_evaluating_shell(tmp_path, monkeypatch):
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    dotenv = tmp_path / '.env'
    dotenv.write_text('IGNORED=$(false)\nexport OPENAI_API_KEY="test-key"\n')
    assert api_key(dotenv) == 'test-key'
    monkeypatch.setenv('OPENAI_API_KEY', 'environment-key')
    assert api_key(dotenv) == 'environment-key'


def test_model_tool_request_and_response(monkeypatch):
    candidate = {'name': 'test', 'hypothesis': 'stagger contacts', 'gait': Gait().to_dict()}
    class Response:
        def __enter__(self):
            import io
            return io.StringIO(json.dumps({'id': 'response-test', 'model': 'test-model', 'status': 'completed',
                'output': [{'type': 'function_call', 'name': 'evaluate_gaits',
                            'arguments': json.dumps({'candidates': [candidate] * 3})}]}))
        def __exit__(self, *args):
            pass
    def open_request(request, timeout):
        assert request.full_url == 'https://api.openai.com/v1/responses'
        assert b'secret-value' not in request.data
        assert request.headers['Authorization'] == 'Bearer secret-value'
        payload = json.loads(request.data)
        assert payload['tools'][0]['strict'] and payload['store'] is False
        assert payload['max_output_tokens'] == 6000
        return Response()
    monkeypatch.setattr('power_rangers.gait_search.urlopen', open_request)
    result = OpenAIProposer('test-model', 'secret-value').propose({'history': []})
    assert result['response_id'] == 'response-test'
    assert len(result['candidates']) == 3


def test_provider_errors_redact_credentials(monkeypatch):
    import io
    from urllib.error import HTTPError
    secret = 'sk-private-example'
    def reject(*args, **kwargs):
        body = io.BytesIO(json.dumps({'error': {'message': f'Invalid key: {secret}'}}).encode())
        raise HTTPError('https://api.openai.com/v1/responses', 401, 'Unauthorized', {}, body)
    monkeypatch.setattr('power_rangers.gait_search.urlopen', reject)
    with pytest.raises(RuntimeError) as failure:
        OpenAIProposer('test', secret).propose({})
    assert secret not in str(failure.value)
    assert '[redacted]' in str(failure.value)


def test_completed_trial_is_reused_after_journal_reload(tmp_path, monkeypatch):
    class Runtime:
        entries = {}
        def call(self, actor, run_id, method, *args):
            if method == 'inspect':
                return self.entries.copy()
            key, value = args
            self.entries[key] = value
            return json.loads(value)
    calls = []
    def trial(*args, **kwargs):
        calls.append(args)
        return {'speed_m_s': .2}
    monkeypatch.setattr('power_rangers.gait_search.evaluate', trial)
    runtime = Runtime()
    first = Journal(runtime, 'test').trial(Gait(), 6., 0, tmp_path)
    second = Journal(runtime, 'test').trial(Gait(), 6., 0, tmp_path)
    assert first == second and len(calls) == 1
    Journal(runtime, 'test').trial(Gait(), 6., 1, tmp_path)
    assert len(calls) == 2
