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

Or just use the web-app: https://anodized.vercel.app/

## The idea

**Port shape is the type system.** Circle = rotational, square = linear,
triangle = electrical, hexagon = measurement (read-only), bar = control
(writes back into the physics). Shapes have to match — the canvas refuses a
bad connection while you drag. Click the **Library** button for a legend of
every port and block.

**The drum is the only block with mismatched ports** — round in, square out —
because converting rotation to travel is a real change of domain. Try wiring
an elevator straight to a gearbox and the compiler tells you to add one.


**Controllers** 
PID, bang-bang, and LQR all read a
measurement through a hexagon input and drive a motor through a bar port,
closing a real feedback loop inside every timestep. PID and bang-bang pick a
position or velocity channel to track; LQR reads shaft state directly and
derives its own plant from the attached chain — you set costs (Q, R), it
solves the gains via a closed-form Riccati solution.

**QOL Feautures** The graph re-simulates ~180 ms after any change — no need to
hit Run after every edit. A block that fails to compile outlines in red on
the canvas. Click a connection to delete it.

**Output blocks.** 
Add as many plotters as you want,
name them, and wire different measurements into each. The Graphs tab compiles
every plotter into one stacked view; the Design tab's bottom panel follows
whichever plotter you have selected.

**Save and load.** Designs export to JSON with a version field, so future
schema changes can migrate old files rather than silently mis-reading them.

**Multiple mechanisms, one shared battery.** Add a second motor→gear→solid
chain and it's simulated alongside the first, not ignored. Their motion is
independent, but their current is not: both draw from the same closed-form
bus-voltage solve every timestep, so an arm and a flywheel pulling current at
once sag the SAME bus for both — verified against running each in isolation,
where the shared-bus case sags deeper than either could reach alone. Two
motors driving the *same* solid (a differential, a dual-motor merge) is
rejected with a specific error naming both motors; that's still a real
feature, just not this one.

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

- Branching topologies — differentials, dual-motor merges (two motors driving
  one shaft is explicitly rejected today, not silently mishandled)
- Feedforward-only and motion-profiled controllers
