# Anodized

A block-diagram sketchpad for FRC mechanisms. Drag motor, gear, solid, and
battery blocks together, run a forward time-domain simulation, and plot any
measurement against time.

## Run it

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

## How it works

**Port shape encodes type.** Circle is rotational, square is linear, triangle
is electrical, hexagon is a measurement tap. A round port will not accept a
square one, and the canvas refuses the connection while you drag.

**The drum is the interesting block.** It is the only one with mismatched
ports — round in, square out — because converting rotation to travel is a real
change of domain, not a formatting detail. An elevator carriage will not
connect to a plain gearbox, and the error tells you to add a drum.

**Gravity mode is what separates mechanisms.** An arm, an elevator, and a
flywheel differ in exactly one parameter on the solid block. There is no
per-mechanism code anywhere in the solver.

**Everything simulates in the rotational domain.** Linear mass becomes
equivalent inertia at the drum, and metres only reappear at plot time.

**Control blocks are their own category.** Three so far: PID, bang-bang, and
LQR. Each reads a measurement through a hexagon input and drives a motor
through a long bar port. Unlike signal edges, which are read-only taps, a
control edge closes a real feedback loop — the controller runs inside every
timestep, between reading state and computing torque.

PID and bang-bang share the same error-source pattern: pick a position or
velocity channel wired into the hex input, set a target. PID additionally
takes kP / kI / kD / kF. Bang-bang takes an output magnitude and a deadband —
full send in whichever direction closes the error, nothing inside the
deadband, no in-between.

Error sources are restricted to position and velocity. Current and torque are
solved later in the same timestep, so a controller cannot read them without a
lag; the compile step rejects them with a message saying so.

**LQR regulates the full state at once.** It does not use the source-channel
pattern — it reads the terminal solid's position and velocity directly, since
v1 has exactly one mechanical chain. The plant (motor constants, ratio,
efficiency, effective inertia) is derived automatically from the compiled
graph rather than asked of the user; only the state costs (Q) and control cost
(R) are exposed. Gains come from a closed-form solution of the continuous
Riccati equation, exact for the theta-omega plant shape every mechanism here
produces — no matrix library, verified numerically against the Riccati
equation across several plant shapes including the degenerate qPos=0 case
(pure velocity regulation, what a flywheel wants). Optionally cancels gravity
with a feedforward computed each step from the plant's own geometry, rather
than a hand-tuned constant.

**Controllers are their own category.** A PID block reads a measurement through
a hexagon input and drives a motor through a long bar — a fifth port type that
carries a command rather than power or data. It is the only connection that
closes a loop, and it runs inside every timestep between reading shaft state
and computing torque.

## Layout

```
src/sim/       headless solver, no React dependency
  motors.ts    motor catalogue and derived constants
  blocks.ts    block schemas, port types, connection validation
  compile.ts   graph traversal -> flat solver parameters
  solver.ts    the timestep loop
src/canvas/    node components with shape-coded handles
src/Chart.tsx  canvas plot with dual axes and a brownout band
src/Inspector.tsx  property editor for the selected block
```

`src/sim` is pure functions and can be imported anywhere, including a test
runner or a Node script.

## Tuning the PID

Gains are in duty per unit of error, so with an arm measured in degrees a kP of
0.02 means full output at 50 degrees off target. Starting points that behave
sensibly on the default arm:

| Gains | Result |
|---|---|
| kP 0.02 alone | settles in 0.35 s, sits 0.36° low under gravity |
| kP 0.004 | never arrives — 2.6° short, forever |
| kP 0.02, kD 0.004 | no overshoot, slower approach |
| add kI 0.05 | kills the droop, but overshoots ~20° |
| kP 0.02, kD 0.004, kF 0.08 | feedforward holds gravity, no integral needed |

The integral term is what removes steady-state error, and it is also what
causes the overshoot. On a gravity-loaded mechanism kF usually beats kI.

Two details in the implementation worth knowing about:

- **Derivative acts on the measurement, not the error.** Differentiating error
  makes output spike the instant a setpoint changes.
- **Conditional integration.** The integral stops accumulating while output is
  pinned at ±1 and the error would push it further into the rail. Without this
  an arm that saturates on the way up sails far past its setpoint.

Error sources are limited to position and velocity channels. Current, voltage,
and torque are solved later in the same timestep, so feeding one back would
make an algebraic loop rather than a control loop.

## Not built yet

- Motion profiling, bang-bang, and other controller types (they slot in beside
  PID with the same two ports)
- Save and load
- Branching topologies — differentials, dual-stage elevators
