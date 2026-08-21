# Code export — PARKED, not wired up

These modules generate WPILib + AdvantageKit subsystems from a compiled
mechanism. They are **intentionally not referenced anywhere in the app** — the
"Export code" button and its result banner were removed from `App.tsx` while
the generator is refined.

The code is kept rather than deleted because it works and is tested: at the
time it was parked, it produced 15 files from the demo design, all of which
compiled under `javac` against stubs, and the archive passed `unzip -t`.

Nothing imports these files, so Vite excludes them from the bundle. They cost
nothing at runtime and are still type-checked by `tsc`, which means they will
not silently rot as the `compile`/`solver` types change — a breaking change
upstream shows up as a build error here rather than as a surprise on the day
this is switched back on.

## Re-enabling

Five edits to `src/App.tsx`, all removed together:

1. `import { generateJava } from './export/java';`
   `import { makeZip, downloadBlob } from './export/zip';`
2. `const [exportNote, setExportNote] = useState<{ text: string; warnings: string[] } | null>(null);`
3. The `onExportCode` handler — compiles the graph fresh, generates, downloads,
   and sets `exportNote`.
4. The "Export code" button in the top bar.
5. The `exportNote` banner (`.loadbar.ok`), rendered just above `showLibrary`.

The `.loadbar.ok` and `.export-warn` rules are still in `styles.css`, so step 5
needs no CSS work.

## Known gaps to address before shipping it

- Gains are translated from the simulated tune by scaling for a nominal 12 V
  bus. That is a starting point, not a tune — the model has no friction,
  backlash, or sensor noise.
- CAN ids, inversion, and soft limits are emitted as `TODO` placeholders,
  since none of them are physics the simulator can know.
- Brushed motors (CIM, MiniCIM, 775pro) get a documented stub instead of a
  hardware layer; only TalonFX and SPARK MAX are templated.
- The vendor API calls were verified against hand-written stubs, which checks
  syntax and self-consistency but **not** conformance to real Phoenix 6 /
  REVLib signatures. Compile against the actual vendordeps before trusting it.
