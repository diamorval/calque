# Anti-slop: the markers of a generated deck, and the fix for each

A deck can pass every pack check and still read as machine output. This file lists the generic
tells so that authoring workflows negate them **while writing**, `lint_deck` blocks the mechanical
ones, and `review` audits the rest. Brand-specific vocabulary, punctuation preferences and banned
words live in the active pack (`pack://<id>/voice`, `pack.yaml` `lint.banned_words`), never here.

Who reads what: `build` and `draft` run sections 1–4 as a checklist on every slide before lint.
`lint_deck` parses section 5. `review` treats everything as bugs to flag.

## 1. Structure tells (checklist)

| Tell | Why it reads generated | Fix |
| --- | --- | --- |
| An **agenda** slide that is a bullet list of section names | A list of nouns says nothing | Clone the pack `summary` role and give each chapter its message, not its topic |
| A **key takeaways / in summary** slide at the end | Admits the slides before it did not land | Put the verdict in each slide title; close on the decision or the next step |
| A **thank you / questions?** closer | Filler | Clone the pack `closing` role as-is, or end on a slide naming what happens next, with a date |
| **Three symmetric bullets** of equal length, slide after slide | Uniform rhythm is the clearest generated signal | Vary count and length; one item may be a sentence, another a figure |
| **Identical card grids** (3 or 4 cards, one icon, one line each) as default | Form chosen for symmetry, not derived from the message | Doctrine table; only a catalogue earns a grid |
| **Title = topic** ("Architecture", "Results", "Budget") | A label instead of a claim | Title = the message, one line within `grid.title.max_chars` |
| **Noun + dash + qualifier** titles | The dash does the thinking the sentence should do | A colon, a verb, or two sentences |
| **Introduction / Context / Conclusion** as section names | School-essay outline | Name sections by their claim |
| Every bullet opening with the same verb form | Template thinking | Rewrite as prose or mix figures, verbs and nouns |
| A **stack of one-line text boxes** where a block belongs | Fragments drift apart on first edit | One frame per idea group (doctrine → Build rules) |
| **Typed bullets or hand-written numbers** | A picture of a list: will not renumber or re-level | Native paragraph bullets and numbering |
| **Next steps** without owner or date | Generic by construction | Each step names who and when, or it is not a step |
| 3+ consecutive slides of the same form | Distinct message types were flattened | Re-derive forms from message types |

## 2. Copy tells

Openers and connectors that exist only in generated text: "In today's fast-paced world", "Let's
dive in", "It is essential to", "not just X, it's Y". Consulting and AI vocabulary used without a
mechanism: leverage, seamless, unlock, empower, holistic, cutting-edge, state-of-the-art, game
changer, synergy, robust (against what?), journey (whose?). Each lexical hit is a **WARN**: the
word may be fine in a sentence that says what it does.

### Tone tells (checklist)

| Tell | Why it reads generated | Fix |
| --- | --- | --- |
| **Truism**: a general truth any reader already holds | The reader learns nothing about this client | Replace with the observed fact from the source: which figure, which system, which team, how much |
| **Punchline closer**: a short aphorism after the fact | It performs insight | Delete it; end on the last fact |
| **Inverted antithesis**: "about X, not Y" | Same tic as "not just X, but Y", turned around | One claim, carried by the fact |
| **Every line a slogan**: short, balanced, quotable | Uniform punchy rhythm | Plain explanatory sentences, as a consultant explains to the client |

**The sentence test:** could it sit unchanged in another client's deck? If yes, it is filler. Put
the client's fact in it, or cut it. With no fact in the source, write the pack's `missing_value`
placeholder rather than a generality.

## 3. Typography tells

A typed bullet glyph inside a run, ellipsis, emoji in a client deck, bullets nested three levels
deep. Punctuation and casing preferences (dashes as separators, separator glyphs, exclamation
marks, parentheses, title casing) are charter choices: they live in the pack's `voice` and
`lint.banned_words`, not here.

## 4. Visual tells (checklist, on the render)

- Rocket, light-bulb, sparkle, brain or handshake icons; one icon per bullet as decoration.
- Gradient blobs and glows; drop shadows on cards; 3D isometric illustrations.
- Stock photos of keyboards, handshakes, people pointing at screens.
- A chart drawn for a single number; a chart with no real data.
- Everything centred.
- **A short accent rule** (a thin bar a few tenths of an inch wide in `role.color.accent`) above
  or under an eyebrow, statement or card title: decoration standing in for hierarchy. The label
  and whitespace do that job.
- Outlined boxes on a blank background where the exemplar uses filled panels or images.
- `role.color.highlight` on more than one element; `role.color.status.*` used decoratively.
- A recipe reproduced at identical geometry twice in one deck.

The pack's icon set, image treatment and flat fills are the vocabulary (`pack://<id>/DESIGN.md`).

## 5. Machine rules (parsed by `lint_deck`)

One rule per line: `SEVERITY  LANG  /regex/  note`. Severity `ERROR` or `WARN`; lang `en`, `fr`
or `any` (informative). The regex runs case-insensitive and multi-line on each text shape;
`(?-i:…)` opts out of case folding. The note follows the closing slash after two or more spaces.
`#` starts a comment. Pack rules (`lint.banned_words`, `lint.placeholders`) are appended at run
time and may raise a WARN here to ERROR; they never lower one.

Exemption: the text of a slide cloned from the pack `closing` role keeps its signature line, as
long as it reads exactly as the template writes it. Copy rewritten there is linted like any other.

```anti-slop
# --- typography (generic) ---------------------------------------------------
ERROR  any  /•/  typed bullet character: use a native paragraph bullet
ERROR  any  /…|\.\.\./  ellipsis: finish the sentence
ERROR  any  /[🌀-🫿⭐✅❌⚠✨]/  emoji: use a pack icon or nothing
# --- structure -------------------------------------------------------------
ERROR  any  /^\s*(thank you|thanks|merci|des questions|questions|q\s*&\s*a)\s*[.!?]?\s*$/  closer slide: clone the closing role or end on the next step with a date
ERROR  any  /^\s*(key takeaways?|takeaways|à retenir|ce qu'il faut retenir|en résumé|in summary|to sum up)\s*[.:]?\s*$/  takeaways slide: put the verdict in each slide's title
WARN   any  /^\s*(agenda|sommaire|conclusion|introduction|contexte|context|next steps|prochaines étapes)\s*[.:]?\s*$/  topic as title: state the message, or name owner and date for a step
# --- openers and connectors -----------------------------------------------
ERROR  en   /\bin today'?s (fast-paced|ever-changing|rapidly (evolving|changing)|digital) (world|landscape|era|environment)/  generated opener: start with the fact
ERROR  fr   /\bdans un monde (en (constante|perpétuelle) (évolution|mutation)|de plus en plus)/  generated opener: start with the fact
ERROR  any  /\b(let'?s dive in|plongeons)\b/  generated connector: delete it
WARN   fr   /\bà l'ère (du|de la|de l')/  "à l'ère de": name the change instead
WARN   fr   /\bil est (essentiel|crucial|primordial|fondamental) de\b/  throat-clearing: say the thing
WARN   en   /\bit'?s (essential|crucial|important) to\b/  throat-clearing: say the thing
WARN   en   /\bnot (just|only|merely) \b.{1,40}\b(but|it'?s|rather)\b/  antithesis construction: one claim, carried by the fact
WARN   fr   /\bpas (seulement|uniquement|simplement) \b.{1,40}\bmais\b/  antithesis construction: one claim, carried by the fact
WARN   en   /\w, not (the|a|an|its|their|our|your|just|only)\b/  inverted antithesis: one claim, carried by the fact
WARN   fr   /\w, (et )?(pas|non) (le|la|les|l'|un|une|des|du|seulement)\b/  inverted antithesis: one claim, carried by the fact
# --- consulting and AI vocabulary ------------------------------------------
WARN   en   /\b(leverag(e|es|ing)|seamless(ly)?|unlock(s|ing)?|empower(s|ing|ment)?|holistic|cutting-edge|state-of-the-art|game[- ]?changer|synerg(y|ies))\b/  buzzword: replace with what it does
WARN   en   /\b(robust|journey)\b/  vague: robust against what, whose journey
WARN   fr   /\b(synergie|synergies|clé en main|clés en main|au cœur de|au service de|levier|leviers|pilier|piliers)\b/  consulting tic: name the mechanism instead
```
