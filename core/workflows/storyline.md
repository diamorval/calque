# Workflow: storyline (co-design the narrative before the deck)

**Purpose.** Turn a validated brief (and notes from any prior meeting) into an **agreed
storyline**: the ordered narrative beats that [build](build.md) maps to slides. Interactive by
design: the agent proposes, the human owner of the deck decides. A storyline nobody challenged is a
draft, not an agreement.

This file is the generic **method**. The company's routing taxonomy (situations, tones, angles,
deck types) and its catalogue of narrative archetypes live in `pack://<id>/storyline`. If the pack
has none, use the fallback taxonomy below and say so.

## Reads

- The brief and meeting notes supplied by the user (required: no brief → ask for one; a brief the
  owner has not validated → ask before routing on it).
- `pack://<id>/storyline` (routing questions, archetypes with beat skeletons and evidence needs).
- `pack://<id>/voice` for every line of copy drafted.

No Calque deck tool is called: the output is a document. `list_packs` only if no pack is active.

## Routing: ask before choosing

Walk the questions **in order**. Answer each from the material first, citing its source (brief
section, meeting note, or the owner's answer in this session). **A missing answer is a question to
the owner, never an assumption.**

| # | Question | What it fixes |
| --- | --- | --- |
| Q1 | What do we already have on this audience? (nothing / some meetings / full account knowledge) | Evidence depth and deck type: nothing → research first, argue at sector level; partial → mixed, name the gaps; full → audience-specific throughout. |
| Q2 | What is the audience's sector or domain? | Vocabulary, examples, credible pains. An open list: name the real sector. |
| Q3 | Who is in the room (function, seniority)? | With Q2, locks which pains and proofs are credible. |
| Q4 | How mature is the audience on the subject? | **Tone**: educate (not started) · accelerate (started, stuck) · optimise (at scale). |
| Q5 | What triggered the meeting? | **Angle**, e.g. growth target, cost pressure, risk or regulation, an event. An open trigger stays open: ask the room. |
| Q6 | What deck type does Q1 allow? | How deep the evidence can go. |

The pack may rename, extend or reorder these; its version wins. The walk ends with a **routing
record**: each answer with its source.

## Choosing an archetype

1. Shortlist the pack archetypes whose declared fit matches the **tone × angle** pair.
2. **Angle wins over tone** when they conflict: the trigger is why the audience took the meeting;
   tone only changes how the first beats are pitched.
3. **One archetype per deck.** Never blend skeletons. If two fit, present the choice with a
   one-line trade-off.
4. State the pick in one sentence and the **runner-up** rejected, with why.
5. Never invent an archetype mid-session. A missing archetype is a pack change, proposed
   separately.

Fallback (pack without a catalogue): a generic spine of `situation → complication → what it means
for you → options → recommendation → proof → next step`, adapted to the angle.

## Beats

- Draft the beats from the archetype's skeleton, each **filled with this audience's evidence**: a
  sourced fact, a quote from the notes, or a named gap to probe. A beat without evidence is cut or
  flagged.
- Each beat carries a **one-line message** (a claim, not a topic) and a **slide intent** (a hint:
  "proof with a figure", "a question to the room"), never a layout.
- The audience's part of the story gets the most room; what is true but not needed to advance the
  meeting goes to an appendix beat.
- Recommend the story, not the sale: no invented commitments, prices or promises.

## Steps

1. Read the brief, the notes, the pack storyline.
2. Walk the routing questions; announce the routing record.
3. Propose one archetype (with runner-up).
4. Draft the beats with evidence.
5. **Iterate live**: show the beat list compactly; change order, emphasis and evidence with the
   owner until they say it is agreed. Record what changed and why.
6. Deliver the storyline document.

## Output

```markdown
# Storyline: <audience>, <date>

## Routing record
Situation · sector · function · tone · angle · deck type, each with its source.

## Archetype
<name>: why it fits (one sentence). Runner-up rejected: <name>, why (one sentence).

## Beats
| # | Beat | Message (one line) | Evidence (source) | Slide intent |

## Agreed in session
What the owner changed from the proposal; open items (evidence to fetch before building).
```

The `Message` and `Slide intent` columns become the `message` and a first guess at
`message_type` of each DeckSpec slide in build.

## Stop conditions

- **Stop and ask** on any missing routing answer, a missing or unvalidated brief.
- **Stay upstream of the deck**: no layouts, no visual design, no deck tool calls.
- **Done** when the owner says the storyline is agreed and the success test passes: read the beat
  messages top to bottom; they form one complete argument **for this audience**. If another
  audience's name could replace this one without breaking a beat, sharpen the beats that lost
  their anchor (an evidence depth of "sector level" is the only sanctioned looseness).
