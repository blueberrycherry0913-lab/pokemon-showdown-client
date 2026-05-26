# Claude Handoff — Pokémon Fan Game Showdown Client

This file is the knowledge-transfer document for the **client** repo (`pokemon-showdown-client`). For server-side conventions, the Testing Standard format, the SP system, domain conditions, status reworks, etc., see `CLAUDE.md` in the server repo (`pokemon-showdown`). This file covers client-only architecture, systems, and pitfalls.

**Read both CLAUDE.md files before doing work that touches both repos.**

---

## 1. Repo overview

**URL:** `https://github.com/blueberrycherry0913-lab/pokemon-showdown-client`

**Local path:** `C:\Users\primo\Documents\GitHub\pokemon-showdown-client`

**Branch:** `master` — edit and push directly, no PR flow.

**Build commands:**
- `node build` — compiles TypeScript via esbuild + updates cachebuster hashes. Use this when editing `.ts` files.
- `node build full` — does everything `node build` does PLUS runs `build-indexes` / `build-learnsets` / `build-minidex`, which re-clone the server cache and rebuild the teambuilder data tables. **Use `full` when editing `build-tools/build-indexes` or after major species/move data changes.**

**Deploy:** The user runs `C:\Users\primo\Desktop\launch-showdown-clean.bat`, which pulls both repos and rebuilds before launching. Push to origin/master first, then tell the user to run the bat.

**Uncommitted user changes (handle carefully):** `play.pokemonshowdown.com/js/client-endload.js` and `play.pokemonshowdown.com/src/battle-tooltips.ts` may have user edits. Never use `git add -A` — always `git add <specific-files>`.

---

## 2. The two teambuilders — CRITICAL

The client has two parallel teambuilder UIs. The user's launch bat opens the **legacy** one via `testclient.html`. Patch both when changing teambuilder behavior.

| HTML | Loads | Source | How to update |
|---|---|---|---|
| `testclient.html` *(user sees this)* | `js/client-teambuilder.js` | Hand-written JS, NO TypeScript source | Edit `.js` directly |
| `preactalpha.html` / `testclient-beta.html` | `js/battle-team-editor.js` | `src/battle-team-editor.tsx` | Edit `.tsx`, `node build` compiles |

**Known gap:** The champions dual-ability UI (awakened display + "Abilities" label) was implemented only in `client-teambuilder.js`. `battle-team-editor.tsx` still has the default single-ability layout. Port this before the user switches to `preactalpha.html`.

---

## 3. Battle client architecture

### Key files

| File | Purpose |
|---|---|
| `play.pokemonshowdown.com/src/battle.ts` | Core battle client: parses log lines, drives animations and UI |
| `play.pokemonshowdown.com/src/battle-animations.ts` | All animation definitions: move anims, other anims, effects |
| `play.pokemonshowdown.com/src/battle-scene.ts` | Scene: sprite management, camera, `showEffect`, `timeOffset`, `waitFor` |
| `play.pokemonshowdown.com/src/battle-tooltips.ts` | Stat hover tooltips and move BP/accuracy display |
| `play.pokemonshowdown.com/src/battle-dex.ts` | Client dex: sprite routing, `getSpriteData`, `getTeambuilderSpriteData`, `getPokemonIconNum` |
| `play.pokemonshowdown.com/src/battle-dex-data.ts` | `Species` class, `spriteid` computation |
| `play.pokemonshowdown.com/src/battle-choices.ts` | `BattleChoiceBuilder` — client-side choice accumulation |
| `play.pokemonshowdown.com/src/panel-battle.tsx` | Preact battle panel: move buttons, MC panel, choice rendering |
| `play.pokemonshowdown.com/js/client-battle.js` | Legacy battle panel (what user sees in `testclient.html`) |
| `build-tools/build-indexes` | Generates `teambuilder-tables.js` and `text.js` from server data |

### `stepQueue` and `nextStep()`

The battle log arrives as a flat array of `|pipe|delimited` lines. `battle.ts` processes them one at a time via `stepQueue` (an array of parsed line objects). The main driver is `nextStep()`, which processes lines until an animation starts or a wait condition is hit.

**`waitForAnimations`** controls how `nextStep()` paces:
- `true` (default) — wait for pending animations before processing next line
- `false` — don't wait (used for fast-forward / seeking)
- `'simult'` — reset `timeOffset = 0`, continue without waiting (used for simultaneous events like mega evolution + move, and now speed ties)

**`timeOffset`** — accumulator in `BattleScene`. `showEffect()` adds `scene.timeOffset` to its start time, so multiple effects queued synchronously play with correct relative timing. `PokemonSprite.anim()` does NOT use `timeOffset` — it chains jQuery on the element directly, so sprite animations on different elements are always parallel.

### `run()` — the line dispatcher

`run(args, kwArgs)` in `battle.ts` is called for each log line. It handles kwArgs like `[from]`, `[of]`, `[simult]`, etc., then routes to `runMajor(args, kwArgs)` or `runMinor(args, kwArgs)`.

**`maybeCloseMessagebar(args, kwArgs)`** — called in `run()` to detect major→major section breaks. When a major event (like `|move|`) opens the message bar and the next event is also major, `maybeCloseMessagebar` backs up `currentStep`, exits `nextStep()`, waits for the bar-close animation (~250ms), and resumes. This is the root cause of sequential animations for speed-tied moves — see §5 below.

### `runMajor()` and `runMinor()`

| Function | Handles |
|---|---|
| `runMajor` | `move`, `switch`, `drag`, `faint`, `win`, `tie`, `turn`, etc. — the "big" events that drive the action bar and major animations |
| `runMinor` | `-damage`, `-heal`, `-status`, `-boost`, `-weather`, etc. — effect events that update HP bars, stat icons, animations |

---

## 4. Animation system

### `BattleMoveAnims` and `BattleOtherAnims`

Defined in `play.pokemonshowdown.com/src/battle-animations.ts`.

**`BattleMoveAnims`** — keyed by move ID. Played by `animateMove()` in `battle.ts`. Most moves have custom animations; fallback is a generic attacker-lunges animation.

**`BattleOtherAnims`** — keyed by a string ID. Played by `scene.runOtherAnim(id, pokemons)`. Used for non-move animations: mega evolution burst, status animations, and now `speedtiecontact`.

### `showEffect(effect, startData, endData, easing)`

Shows a sprite effect (particles, wisps, etc.) in the scene. `startData.time` is offset by `scene.timeOffset`, so multiple `showEffect` calls at different times during a single animation step play with correct sequencing.

### `PokemonSprite.anim(data, easing)`

Chains a jQuery `.animate()` on the sprite's DOM element. Because it chains directly on the element, **it ignores `scene.timeOffset`**. Multiple `anim()` calls on the same sprite play sequentially (chained queue); calls on different sprites play in parallel (separate elements). This is why the `speedtiecontact` animation fires both sprites simultaneously with no extra synchronization code.

### Adding a new `BattleOtherAnim`

```typescript
myAnim: {
    anim(scene, [attacker, defender]) {
        // attacker and defender are PokemonSprite instances
        attacker.anim({ x: ..., y: ..., z: ..., time: 250 }, 'decelerate');
        scene.showEffect('wisp', { x: ..., scale: 0, opacity: 1, time: 0 },
                                  { scale: 2, opacity: 0, time: 300 }, 'linear');
        scene.wait(250); // triggers nextStep() after 250ms
    },
},
```

Invoke with: `this.scene.runOtherAnim('myAnim' as ID, [poke1, poke2])`.

---

## 5. Message bar lifecycle

This is one of the most surprising systems in the client. Understanding it is essential when implementing simultaneous events.

### How the message bar opens and closes

1. A `|move|` line hits `runMajor`. It calls `this.log(args, kwArgs)` which calls `this.scene.log.message(...)`. This opens the message bar with "Poke used Move!"
2. The message bar has a CSS animation — it slides in over ~150ms.
3. When the **next** event arrives, `run()` calls `maybeCloseMessagebar(args, kwArgs)`.
4. `maybeCloseMessagebar` calls `sectionBreak(args, kwArgs)` which returns `true` whenever a major event follows another major event (regardless of content).
5. If `sectionBreak` returns true, `maybeCloseMessagebar` backs up `currentStep--`, sets `this.messagebarOpen = false`, starts the bar-close animation (~150ms), and returns `true` to `run()`.
6. `run()` returns early. The current line is not processed yet — it's re-queued for after the animation.
7. After the bar closes, `nextStep()` is called again for the same line.

**Why this matters for speed ties:** Two `|move|` lines in a row trigger this twice. By the time the second `|move|` gets processed (after the bar has closed from the first), the first Pokémon's animation is already 250ms in. The two moves never animate simultaneously.

**The fix:** In `run()`, bypass `maybeCloseMessagebar` when you know two major events should play together:
```typescript
if (!this.speedTieAnimPending && this.scene.maybeCloseMessagebar(args, kwArgs)) {
    this.currentStep--;
    this.activeMoveIsSpread = null;
    return;
}
```

---

## 6. Speed tie implementation (§7)

### Overview

When two opposing Pokémon are speed-tied, the server appends `|[simult]` to the first move's log line (and all its effect lines). The client uses this to:
1. Fire a custom `speedtiecontact` animation for both sprites simultaneously instead of the normal lunge
2. Not interrupt between the two `|move|` events with the message bar close animation
3. Simultaneously subtract HP from both health bars

### Client fields and logic

**`speedTieAnimPending`** (in `battle.ts`) — set to `true` after the first `|move|+simult` is processed. The next `|move|` checks this flag to fire `speedtiecontact` rather than `animateMove`.

**Modified `case 'move'` in `runMajor`:**
```typescript
case 'move': {
    // ...standard preamble...
    if ((kwArgs.simult || this.speedTieAnimPending) && poke2 && !this.seeking) {
        this.scene.runOtherAnim('speedtiecontact' as ID, [poke, poke2]);
    } else {
        this.animateMove(poke, move, poke2, kwArgs);
    }
    this.scene.afterMove(poke);
    this.log(args, kwArgs);
    if (kwArgs.simult) {
        this.waitForAnimations = 'simult';  // don't wait; process next event immediately
        this.speedTieAnimPending = true;
    } else {
        this.speedTieAnimPending = false;
    }
    break;
}
```

### `speedtiecontact` animation

```typescript
speedtiecontact: {
    anim(scene, [attacker, defender]) {
        const midX = (attacker.x + defender.x) / 2;
        const midZ = (attacker.z + defender.z) / 2;
        const midY = (attacker.y + defender.y) / 2;
        scene.showEffect('wisp', {
            x: midX, y: midY + 10, z: midZ,
            scale: 0, opacity: 1, time: 250,
        }, {
            scale: 2.5, opacity: 0, time: 500,
        }, 'linear');
        attacker.anim({ x: midX, y: midY, z: midZ, time: 250 }, 'decelerate');
        attacker.anim({ x: attacker.x, y: attacker.y, z: attacker.z, time: 350 }, 'ballistic2Back');
        scene.wait(250);
    },
},
```

Both attacker and defender receive the same animation. Because they are different DOM elements, their jQuery animation queues run in parallel — they meet in the middle simultaneously. The `runOtherAnim` call for the second Pokémon (as "attacker") mirrors the animation.

---

## 7. Custom status client registration

Every non-canon status added on the server needs three client-side registrations:

**1. Type union in `battle.ts`** — two places:
```typescript
// Pokemon class (~line 102)
status: Dex.StatusName | 'tox' | 'scr' | 'cor' | 'mlt' | 'stun' | 'frb' | '' | '???'
// PokemonHealth interface (~line 1028) — same union
```

**2. `parseHealth` allowlist (~line 3355):**
```typescript
} else if (status === 'par' || ... || status === 'stun' || status === 'frb') {
    output.status = status as any;
```

**3. Stat reduction block in `calculateModifiedStats` in `battle-tooltips.ts`:**
Maps status IDs to stat reduction multipliers for the hover tooltip display.

**4. Text entries in `build-tools/build-indexes`** (injected before `text.js` write):
```javascript
Text['stun'] = {start: "  [POKEMON] became stunned!", ...};
Text['frb'] = {start: "  [POKEMON] was frostbitten!", ...};
```
`play.pokemonshowdown.com/data/text.js` is gitignored and regenerated by `build-indexes` — editing it directly is wiped by `node build full`. Only entries in `build-indexes` persist.

**5. Status badge in `battle-animations.ts`** — add a badge span in the `statusBar` rendering block (after `mlt` case).

**6. `cantUseMove()` case in `battle.ts`** — for lockout statuses, add a `case 'stun':` that fires the status animation and result badge.

---

## 8. Sprite redirect system

Fully documented in server `CLAUDE.md §15`. Quick summary:

- `species.spriteid` has hyphens (`'venusaur-megax'`), `species.id` does not (`'venusaurmegax'`). Use the right format for each redirect point.
- Three redirect points: `getSpriteData` (battle sprite), `getTeambuilderSpriteData` (teambuilder sprite), `getPokemonIconNum` (icon sheet).
- Mega sprites don't exist in `sprites/home-centered/` — redirect to `sprites/dex/` or `sprites/ani/`.
- Always verify CDN URL with WebFetch before writing a redirect.

---

## 9. Pitfalls

1. **`PokemonSprite.anim()` ignores `scene.timeOffset`.** Sprite animations are always relative to "now" — chain multiple calls on the same sprite for sequential playback, or call on different sprites for parallel playback. Only `showEffect()` respects `timeOffset`.

2. **The message bar intercepts every major→major event sequence.** If you add new simultaneous-event pairs (beyond speed ties), you must bypass `maybeCloseMessagebar` for those pairs too, using a flag similar to `speedTieAnimPending`.

3. **`waitForAnimations = 'simult'` resets `timeOffset = 0`.** This means any effects queued BEFORE setting `simult` on the first event and effects queued on the second event share the same `timeOffset = 0` baseline. Plan animation timing accordingly.

4. **`play.pokemonshowdown.com/data/text.js` is gitignored.** It's generated by `build-indexes`. Custom status text must be injected in `build-tools/build-indexes`, not in the generated file.

5. **Patching only one teambuilder** — always patch both `client-teambuilder.js` and `battle-team-editor.tsx` when changing any teambuilder behavior. The user currently sees `testclient.html` (legacy) but will eventually switch.

6. **Format ID substring: `'testingstandard'` not `'teststandard'`.** All client format detection uses `format.includes('testingstandard')`. Using `'teststandard'` silently fails.

7. **`addDiv('battle-history', html)` bypasses Caja HTML sanitization.** Use this (not `add` or `message`) when injecting custom HTML with inline styles into the action log. `add` and `message` go through the sanitizer, which strips `style=` attributes.

8. **`node build full` wipes `play.pokemonshowdown.com/data/text.js`.** Anything you write there directly will be lost on next full build. See pitfall 4.

---

*This file is committed to the repo and loaded automatically by Claude Code. For server-side conventions (SP system, type chart, status conditions, domain moves, etc.), see `CLAUDE.md` in the server repo (`C:\Users\primo\Documents\GitHub\pokemon-showdown`).*
