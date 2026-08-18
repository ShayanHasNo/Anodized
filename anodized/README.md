# Anodized

A block-diagram sketchpad for FRC mechanisms. Drag blocks together, wire a
controller, and run a real time-domain simulation — current draw, bus
voltage, brownout risk — instead of a static gear-ratio calculator.

## Run it

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173).

## The idea

**Port shape is the type system.** Circle = rotational, square = linear,
triangle = electrical, hexagon = measurement (read-only), bar = control
(writes back into the physics). Shapes have to match — the canvas refuses a
bad connection while you drag. Click the **Library** button for a legend of
every port and block.

**The drum is the only block with mismatched ports** — round in, square out —
because converting rotation to travel is a real change of domain. Try wiring
an elevator straight to a gearbox and the compiler tells you to add one.

**One solid block covers three mechanisms.** Flywheel, elevator, and arm
differ only in *gravity mode* (none / constant / angle-dependent). There's no
per-mechanism code in the solver — everything runs in the rotational domain,
and metres only reappear at plot time.

**Controllers are their own category.** PID, bang-bang, and LQR all read a
measurement through a hexagon input and drive a motor through a bar port,
closing a real feedback loop inside every timestep. PID and bang-bang pick a
position or velocity channel to track; LQR reads shaft state directly and
derives its own plant from the attached chain — you set costs (Q, R), it
solves the gains via a closed-form Riccati solution.

**It's alive.** The graph re-simulates ~180 ms after any change — no need to
hit Run after every edit. A block that fails to compile outlines in red on
the canvas. Click a connection to delete it.

## Layout

```
src/sim/           headless solver, no React dependency
  motors.ts         motor catalogue and derived constants
  blocks.ts         block schemas, port types, connection validation
  compile.ts        graph traversal -> flat solver parameters
  solver.ts         the timestep loop (PID / bang-bang / LQR dispatch)
src/canvas/        node + edge components
src/Chart.tsx       dual-axis plot with a brownout band
src/Inspector.tsx   property editor for the selected block
src/Library.tsx     port + block reference panel
```

`src/sim` is pure functions — importable from a test runner or a bare script,
no browser required.

## PID quick reference

Gains are duty per unit of error. On the default arm (measured in degrees):

| Gains | Result |
|---|---|
| kP 0.02 alone | settles in 0.35 s, ~0.36° low under gravity |
| kP 0.02, kD 0.004 | no overshoot, slower approach |
| + kI 0.05 | kills the droop, but overshoots ~20° |
| kP 0.02, kD 0.004, kF 0.08 | feedforward holds gravity — no integral needed |

Feedforward usually beats integral on a gravity-loaded mechanism. Two
implementation details worth knowing: derivative acts on the *measurement*,
not the error (no output spike on a setpoint change), and integration is
conditional — it stops accumulating once output is pinned at ±1, so a
saturated arm doesn't sail past its target.

Error sources are limited to position and velocity — current and torque are
solved later in the same timestep, so reading them back would make an
algebraic loop, not a control loop.

## Not built yet

- Save and load
- Branching topologies — differentials, multiple mechanisms in one graph
- Feedforward-only and motion-profiled controllers
