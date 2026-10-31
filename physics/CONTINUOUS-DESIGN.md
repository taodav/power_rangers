# Continuous physics design

**Sequencing update:** independent physical walking and gripping are now the first priority. The one-Ranger bench in `RANGER-STATUS.md` is the first measured step; continuous physical combination remains a later milestone.

## Problem statement

Can four independently controlled, durable robot actors use physical feedback to locomote, assemble into a load-bearing machine, and perform coordinated work without replacing their bodies or bypassing the simulation?

Conor's requirement is that the robot actually be physics-informed. The proposed acceptance bar is therefore a continuous physical mechanism, not animated assembly followed by an unrelated physics demonstration. Mechanical feasibility must shape the morphology, docking sequence, and control policies.

## What must stay continuous

- One MuJoCo world and one simulation clock contain the same four robot bodies and the shared core throughout the episode.
- Body identities, mass, inertia, collision geometry, and actuator ownership survive transformation. No mesh replacement is presented as a physical transformation.
- After episode initialization, movement comes from finite-force actuators and contact. No root-position writes, reset into a convenient pose, invisible support, or constraint used to pull distant modules together.
- The renderer reads physical transforms. A failed latch, foot slip, collision, or fall remains visible and is reported as a failure, not hidden by a successful-looking animation.
- Each actor owns its module's actuators before and after docking. Model-level planning, if added later, issues bounded intents; fast local controllers handle servo and balance timescales.

## Proposed mechanism architecture

Use one union model with four independently articulated modules and a shared core. Design explicit mounting frames, physical clearances, and joint travel that permit both independent motion and the intended combined form. A staged physical cradle may be useful for early experiments, but any fixture must be visible, declared, and unloaded before an unsupported walking test can pass. A cradle is a proposed experiment, not autonomous assembly evidence.

Docking is a measured event: the intended mounting frames must be aligned, relative velocity must be small, contacts must be safe, and the relevant actors must agree. Only then may a predeclared latch engage. The latch must have measured reaction loads and a declared failure/release rule. Numerical solver compliance is not, by itself, a physically calibrated latch model.

MuJoCo supports site-defined weld constraints that align two frames, but it can also pull initially distant frames together. The application must prevent that shortcut; merely enabling a weld does not prove docking. [MuJoCo weld reference](https://mujoco.readthedocs.io/en/3.17.0/XMLreference.html#equality-weld)

Constraint enablement can change during simulation through `eq_active`; that provides a mechanism for latch/release experiments without replacing the world. It does not supply alignment checks, load limits, or a mechanically valid transformation for us. [MuJoCo state types](https://mujoco.readthedocs.io/en/3.17.0/APIreference/APItypes.html#mjdata)

## Experiments in order

1. **One physical module:** stand, take contact-confirmed steps, and fold through legal joint travel without self-intersection. The independent and combined configurations belong to the same articulated body.
2. **One coupler bench:** approach, refuse bad alignment, latch, bear a known load, and release. A visible physical fixture is acceptable here; a hidden world weld is not.
3. **Four-module assembly:** preserve every body and state while the modules rendezvous and attach. Record contact forces, latch errors, and load transfer. Mechanism or fixture choices must make the assembly reachable by the actuators.
4. **Unsupported combined movement:** release staging support, stand, and take measured steps. Verify that the combined machine is supported by its feet and that every module stays within actuator and latch limits.
5. **Separation and recovery:** unload couplers before release, retain actor ownership, and return to independent motion. Exercise misalignment, a missing actor, delayed decisions, and a failed latch.
6. **Durable continuation:** checkpoint the full integration state and latch state together with causal actor decisions; restore without replaying an already executed intent or jumping between unrelated physical configurations.

## Measurements that decide success

Track foot contact and clearance, center of mass and support, body tilt, joint error and saturation, collision penetration, latch translation/rotation error, reaction force/torque, mechanical work, and net task progress. Include unsuccessful trials and test multiple initial conditions. Define numerical tolerances before declaring a benchmark passed; attractive motion alone is not a metric.

## Current boundary

The existing native biped walks, and four durable actors authorize its limb intents. That is useful locomotion and coordination evidence. It does not meet the continuous-mechanism bar: the decorative Rangers still roam and assemble kinematically, then initialize a separate physical rig. The next implementation must remove that boundary rather than make the transition prettier. Current evidence is in `STATUS.md`.
