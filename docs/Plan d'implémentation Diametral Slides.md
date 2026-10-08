# Plan d'implémentation : Calque

Oct 7, 2026 · @Augustin MORVAL

## Objectif et règles

**On construit from scratch Calque, une interface de co-édition de slides avec une IA.** Elle sort un PPTX natif éditable conforme à la charte de chaque entreprise, fournie sous forme de *brand pack*. Diametral est le premier pack. Elle s'utilise via MCP depuis Claude Code, Cowork ou Claude avec l'abonnement de l'utilisateur, ou via API dans notre app web avec le fournisseur de modèles choisi. Ce plan est écrit pour un agent de code : on l'exécute phase par phase, et une phase n'est terminée que lorsque tous ses `verify` passent.

| Mode | Depuis | LLM utilisé | Interface | Connexion |
| --- | --- | --- | --- | --- |
| **Via MCP** | Claude Code, Cowork, Claude (web, desktop) | Celui de l'abonnement Claude, Claude joue le rôle d'agent | UI [MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) dans la conversation quand l'hôte la prend en charge. Sinon (Claude Code), un lien vers l'aperçu web du deck. | `claude mcp add` dans Claude Code, connecteur personnalisé dans Claude et Cowork. Aucune clé API. |
| **Via API** | App web | Au choix sur la page Modèles IA ([pattern PipesHub](https://docs.pipeshub.com/ai-models/overview.md)) : Anthropic, OpenAI, Mistral, Gemini, Ollama, gateway Diametral | `apps/web` | Une clé API par fournisseur |

**Pourquoi pas un bouton « connecter mon abonnement Claude » dans l'app :** Anthropic n'autorise pas les produits tiers à proposer la connexion claude.ai ni à utiliser les limites d'un abonnement, sauf accord préalable ([doc Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)). Le mode MCP donne le même résultat en restant conforme : c'est Claude qui vient à l'outil, pas l'inverse.

**Stack :** monorepo pnpm. On utilise TypeScript pour l'UI, l'agent et le serveur MCP, c'est le même langage que le [design system Diametral](https://github.com/DiametralGroup/design-system) qui habille l'app. Le moteur PPTX est en Python (uv, python-pptx) parce qu'il doit ouvrir et cloner le template de chaque entreprise.

**Règles non négociables** (à recopier dans `CLAUDE.md`) :

1. **Deux portes, un seul moteur.** Le mode MCP et l'app web appellent les mêmes outils. Aucune logique métier dans l'UI ni dans l'agent.
2. **Agnostique du fournisseur.** Dans l'app, tous les appels LLM passent par `packages/llm`, un registre de fournisseurs. Aucun SDK de fournisseur ailleurs.
3. **Le LLM n'écrit jamais de PPTX.** Il produit un `DeckSpec` JSON validé par un seul JSON Schema (Zod côté TypeScript, Pydantic côté moteur). Le moteur clone le template du pack et dessine les slides de façon déterministe.
4. **Aucune marque dans le code.** Tout ce qui est propre à une entreprise vit dans son brand pack (`packs/<id>/`), et dans chaque pack `tokens.json` fait foi. La CI échoue si `engine/` ou `core/` contient un nom de marque, un hex ou une police.
5. **Le savoir est en deux couches, jamais en dur dans un prompt :** `core/` (générique) et `packs/<id>/` (propre à l'entreprise).
6. **Une seule UI de slide.** `packages/slide-ui` (aperçu rendu, inspecteur, commentaires) est embarqué à la fois dans `apps/web` et dans l'UI MCP Apps.

## Ce qu'on reprend des 4 projets

On ne forke rien et on ne déploie aucun de ces projets : on reprend un pattern précis à chacun. Comme les licences sont MIT ou Apache-2.0, du code peut être copié avec attribution dans `THIRD_PARTY_NOTICES.md`.

| Projet | Licence | Ce qu'on reprend | Où | Phase |
| --- | --- | --- | --- | --- |
| [Presenton](https://github.com/presenton/presenton) | Apache-2.0 | Un schéma typé que l'IA remplit, puis un rendu déterministe. Serveur MCP qui expose la génération. Déploiement Docker. | `packages/deckspec`, `apps/server` | 2, 3 |
| [open-slide](https://github.com/1weiho/open-slide) | MIT | Inspecteur : clic sur un élément, commentaire, puis l'agent applique. Mode présentateur. | `packages/slide-ui` | 3 |
| [OpenDesign](https://github.com/nexu-io/open-design) | Apache-2.0 | Format `DESIGN.md` portable, lisible par tous les agents. | `DESIGN.md` généré pour chaque pack | 1 |
| [PipesHub](https://github.com/pipeshub-ai/pipeshub-ai) | Apache-2.0 | [Page Modèles IA](https://docs.pipeshub.com/ai-models/overview.md) : catalogue de fournisseurs, bouton Configurer, clé API et modèle, validation à l'enregistrement, plusieurs fournisseurs, modèle par défaut. Pas les connecteurs. | `packages/llm`, `apps/web` | 4, 5 |

## Brand packs : chaque entreprise apporte sa charte

**Le moteur ne connaît aucune marque.** Tout ce qui est propre à une entreprise vit dans un *brand pack* : son template, sa charte, sa voix, ses règles de lint. Une entreprise s'installe en important son pack, sans toucher au code. Diametral est le premier pack. Il est construit depuis le plugin `visual-creation` et sert d'implémentation de référence.

| Couche | Contenu | Fourni par |
| --- | --- | --- |
| `core/` (générique) | Doctrine « la forme suit le message », règles de build, boucle lint puis rendu. Bibliothèque de formes (graphiques, diagrammes, compositions) paramétrée par la grille du pack. Anti-slop générique. Workflows build, storyline, draft, edit, review. | Le produit |
| `packs/<id>/` (spécifique) | `template.pptx`, `template-map.yaml` (rôles : couverture, sommaire, intercalaire, clôture, archétypes), `tokens.json` (DTCG), règles de charte du lint (palette, polices, accents), voix et mots bannis, deck exemplaire, archétypes de storyline, langue par défaut | L'entreprise |

```text
packs/<id>/
  pack.yaml          manifeste : nom, version, langue, rôles, grille, règles de lint
  template.pptx      template officiel de l'entreprise
  template-map.yaml  slides clonables, rôles, shape_id, capacités de texte (généré puis revu)
  tokens.json        couleurs, typographie, espacements (format DTCG)
  DESIGN.md          charte lisible par les agents (générée)
  voice.md           voix, registre, mots bannis (optionnel)
  exemplar.md        deck de référence commenté (optionnel)
  storyline.md       archétypes de narration (optionnel)
  fonts/             polices uploadées par l'entreprise, sous sa responsabilité de licence (repli déclaré dans pack.yaml)
```

**Installer le pack d'une entreprise, sans code :**

1. Importer son `template.pptx`, et son `tokens.json` s'il existe.
2. Extraction automatique : layouts, placeholders, `shape_id`, thème (couleurs, polices), grille. Le moteur génère un `template-map.yaml` et un `tokens.json` brouillons.
3. Revue dans l'UI : assigner les rôles (couverture, sommaire, intercalaire, clôture), marquer les slides à ne jamais cloner, compléter la voix.
4. Validation : le lint passe sur le template lui-même et un deck de test est généré. Le pack est publié pour l'espace de travail.

Un espace de travail peut avoir plusieurs packs, par exemple la charte interne et les templates de clients pour répondre à un appel d'offres.

**Chaque skill devient une fonction du produit, valable pour tous les packs :**

| Skill | Devient | Porte MCP | Porte API |
| --- | --- | --- | --- |
| build-presentation | Workflow `build` : ingestion, challenge ciblé, plan de deck (message, type de message, forme), construction, lint, QA visuelle | Prompt MCP `build-presentation` + outils | Assistant de création |
| storyline-design (pre-sales) | Étape storyline avant le plan : routage, archétype, beats | Prompt MCP `storyline` | Étape 1 de l'assistant |
| draft-slides | Outil `add_slides` : une ou quelques slides, sans arc narratif | Prompt MCP `draft-slides` | Bouton « Ajouter des slides » |
| edit-slides | `import_pptx` + `patch_deck` par `shape_id` sur un deck existant | Prompt MCP `edit-slides` | Import + inspecteur |
| review-deck | Outil `review_deck` : lint, checklist visuelle, corrections sûres, rapport | Prompt MCP `review-deck` | Bouton « Relire » |
| build-portfolio | Hors périmètre v1, même moteur plus tard |  |  |

**Pack Diametral, le premier : d'où vient chaque fichier**

| Fichier du plugin `visual-creation` | Va dans |
| --- | --- |
| `assets/template.pptx` (65 slides) | `packs/diametral/template.pptx` |
| `references/template-map.md` | `packs/diametral/template-map.yaml` (s1 couverture, s2 et s3 sommaires, s4 à s10 intercalaires, s57 clôture, s59 à s63 jamais clonées) |
| `brand.md` + `tokens.json` du [design system](https://github.com/DiametralGroup/design-system) | `packs/diametral/tokens.json` et `DESIGN.md`, réconciliés |
| `voice-core.md`, `tone-of-voice.md`, `writing-rules.md` | `packs/diametral/voice.md` |
| `references/business-presentation-exemplar.md` | `packs/diametral/exemplar.md` |
| `storyline-design` (archétypes, routage) | `packs/diametral/storyline.md` pour le spécifique, `core/` pour la méthode |
| `references/authoring-doctrine.md` | `core/doctrine.md`, purgé de tout ce qui est propre à Diametral |
| `references/compositions.md` | `core/` : recettes réécrites en coordonnées relatives à la grille du pack |
| `references/anti-slop.md` | `core/anti-slop.md` (générique) + règles propres au pack dans `pack.yaml` |
| `scripts/` (`pptx_helpers`, `charts`, `diagrams`, `lint_deck`, `render.sh`) | `engine/`, réécrits avec tests et sans aucune valeur Diametral |

**Ce que ça change dans le plan :**

1. **Le moteur part du template du pack actif, pas d'une page blanche.** Les slides de rôle (couverture, sommaire, intercalaires, clôture) sont clonées et le contenu est dessiné sur mesure. PptxGenJS ne sait pas ouvrir un PPTX existant, donc le moteur est en **Python avec python-pptx**, comme le plugin. Le reste reste en TypeScript.
2. **L'aperçu est le PPTX lui-même**, rendu en PNG par LibreOffice, avec une carte des formes (`shape_id`, bbox). Les commentaires s'ancrent sur le `shape_id`. L'aperçu ne peut pas diverger de l'export.
3. **Dans chaque pack, `tokens.json` fait foi.** La CI vérifie que le thème du template et les règles du pack s'y conforment.
4. **Le savoir est servi à tous les modèles** par MCP (`core/` + pack actif) et chargé dans le prompt système de l'agent web. C'est ce qui rend les skills agnostiques du fournisseur et de l'entreprise.

## Architecture

&#91;embedded content: architecture cible · deux portes (MCP, API), un moteur\]

Claude Code et Cowork (via MCP, avec l'abonnement) et l'app web (via API, avec une clé) passent par le même moteur MCP et affichent la même UI de slide.

```text
apps/server        TS : serveur MCP (outils, ressources, prompts, UI MCP Apps), API REST, versions de DeckSpec, aperçu /decks/:id
apps/agent         TS : agent de l'app web, boucle tool calling
apps/web           TS : UI React (starter vite-react du design system), pages Modèles IA et Brand packs
engine/            Python : DeckSpec vers PPTX (clone du template du pack + compositions), import, patch par shape_id, lint, rendu PNG + carte des formes, extracteur de template
packages/slide-ui  aperçu rendu, vignettes, inspecteur, commentaires
packages/llm       registre de fournisseurs, seul accès aux modèles
packages/deckspec  schémas Zod + JSON Schema partagé avec le moteur
packages/design    tokens DTCG vers thème PPTX et DESIGN.md, par pack
core/              doctrine, compositions, anti-slop, workflows : génériques, sans marque
packs/diametral/   premier pack : template, template-map, tokens, voix, exemplar, storyline
docs/adr/          décisions d'architecture
```

## Phases

Sept phases pour 34 à 42 jours de développement assisté (estimation). Le chemin critique est la Phase 2. Le mode MCP est utilisable dès la fin de la Phase 3, avant l'app web.

### Phase 0 : Socle (1 à 2 jours)

1. Monorepo pnpm + Turborepo, `engine/` en Python géré par uv, TypeScript strict, ESLint, ruff, Vitest, pytest, CI → verify : `pnpm lint && pnpm test && uv run pytest` verts sur la CI.
2. `CLAUDE.md` avec les 6 règles, les commandes et la structure du repo → verify : un agent de code répond correctement à « où ajoute-t-on le pack d'une nouvelle entreprise ? ».
3. ADR 0001 : moteur Python sur le template du pack, aperçu = rendu du PPTX, savoir en `core/` + `packs/` → verify : ADR commité.

### Phase 1 : Format de pack, core et pack Diametral (4 à 5 jours)

1. `pack.yaml` : JSON Schema du manifeste (nom, version, langue par défaut, rôles, grille, règles de lint) et chargeur qui valide un pack complet → verify : un pack incomplet est refusé avec la liste de ce qui manque.
2. `core/` : doctrine, compositions, anti-slop et workflows extraits du plugin `visual-creation` et de `storyline-design`, purgés de toute valeur Diametral → verify : le test CI ne trouve aucun nom de marque, hex ni police dans `core/` et `engine/`.
3. Extracteur de template : à partir de n'importe quel `template.pptx`, il génère un `template-map.yaml` (layouts, placeholders, `shape_id`, géométrie, capacités de texte) et un `tokens.json` brouillon tiré du thème → verify : sur le template Diametral, l'extraction retrouve les `shape_id` du `template-map.md` du plugin.
4. `packs/diametral/` construit depuis le plugin et le design system (tableau ci-dessus), avec un `SOURCE.md` (repo, tag, date) et `pnpm pack:sync diametral` épinglé sur un tag → verify : le pack se charge, et le diff est propre après une sync.
5. `packages/design` : lecture DTCG, résolution des alias, thème PPTX et `DESIGN.md` par pack, réconciliation entre le thème du template et `tokens.json` → verify : écarts listés par pack, CI rouge sur tout écart non arbitré.

### Phase 2 : Moteur PPTX (10 à 12 jours)

1. `packages/deckspec` : un deck = `pack_id` + langue + slides. Chaque slide = `{ message, message_type, form, source }`, où `source` est `clone` (rôle ou slide du pack + valeurs par `shape_id`), `composition`, `chart` ou `diagram` → verify : JSON Schema partagé TS et Python, exemples valides et invalides testés des deux côtés.
2. « La forme suit le message » encodée dans la validation : formes autorisées par type de message, 3 nombres ou plus d'une même dimension = graphique, 3 slides consécutives de même forme refusées → verify : 10 specs fautives rejetées avec un message explicite.
3. Slides de rôle : le moteur clone la couverture, le sommaire, les intercalaires et la clôture **déclarés par le pack**, remplace les placeholders au niveau du run, met `[À COMPLÉTER]` dans les trous et renumérote les pieds de page → verify : un deck minimal passe le lint avec le pack Diametral **et** avec un second pack de test basé sur un template neutre.
4. Contenu sur mesure : graphiques natifs (line, bar, doughnut, scatter), diagrammes (flow, swimlane, layers, hub, matrix2x2, funnel, cycle, before\_after), recettes de composition, icônes teintées, images en crop-to-fill. Couleurs, polices et grille sont lues dans le pack actif → verify : un test par forme sur les 2 packs, et le PPTX rouvert contient des objets chart natifs.
5. Lint paramétré par le pack : police hors charte, hex hors palette, règle d'accent du pack (un seul rouge chez Diametral), placeholder survivant, numéro de page périmé, géométrie, débordement estimé, anti-slop (core + pack) → verify : le self-test du plugin est reproduit avec le pack Diametral, 10 PPTX fautifs détectés.
6. Rendu : LibreOffice headless vers un PNG par slide + carte des formes (`shape_id`, bbox en px, rôle), avec les polices du pack (police de repli si absentes), en ne re-rendant que les slides modifiées → verify : chaque bbox tombe dans l'image, temps de re-rendu d'une slide mesuré et noté dans l'ADR.
7. Import et patch : `import_pptx` d'un deck existant, modification par `shape_id` (logique d'edit-slides) → verify : un titre modifié sur un deck importé sans perte de mise en forme.
8. Tests golden : 3 decks du pack Diametral (dont une reconstitution d'actes de l'exemplar) et 1 deck du pack de test, comparés visuellement → verify : `pytest -m golden` vert.

### Phase 3 : Moteur exposé et mode MCP (5 à 6 jours)

1. `apps/server` : stockage des decks en versions de `DeckSpec` (Postgres), chaque modification crée une version, appels au moteur Python en interne → verify : annulation et retour à une version testés.
2. Serveur MCP (SDK TypeScript officiel, Streamable HTTP et stdio). **Outils** : `create_deck`, `add_slides`, `open_deck`, `import_pptx`, `patch_deck`, `list_comments`, `lint_deck`, `review_deck`, `export_pptx`, list\_packs, import\_pack (tous filtrés par la visibilité du pack). **Ressources** `core://` et pack://\<id>/ : doctrine, compositions, charte, voix, exemplar et template-map du pack actif. **Prompts** repris des SKILL.md : `build-presentation`, `storyline`, `draft-slides`, `edit-slides`, `review-deck`. Plus une API REST équivalente → verify : MCP Inspector liste et appelle tout, et les prompts apparaissent comme commandes dans Claude Code.
3. `review_deck` reprend les étapes de review-deck : inspection, rendu, checklist, rapport par gravité, corrections sûres, vérification → verify : sur un deck avec 10 défauts plantés, le rapport les trouve et le deck corrigé sort à 0 erreur de lint.
4. `packages/slide-ui` : PNG rendu + calque cliquable issu de la carte des formes, commentaire ancré sur le `shape_id`, vignettes → verify : tests de composants sur le clic et le commentaire.
5. UI MCP Apps : `slide-ui` empaqueté en ressource `ui://` (package `@modelcontextprotocol/ext-apps`), lié à `create_deck` et `open_deck`. Un commentaire dans l'UI met à jour le contexte du modèle, qui appelle `patch_deck` → verify : dans Cowork ou Claude desktop, clic, commentaire, Claude applique, et l'aperçu se met à jour.
6. Aperçu web servi par `apps/server` (`/decks/:id`, même `slide-ui`). Chaque outil renvoie ce lien pour les hôtes sans MCP Apps, comme Claude Code → verify : depuis Claude Code, un commentaire posé dans le navigateur est lu par `list_comments` et appliqué.
7. OAuth sur le serveur MCP distant, `claude mcp add --transport http` pour Claude Code, connecteur personnalisé pour Claude et Cowork → verify : un deck de 5 slides produit depuis Claude Code et depuis Cowork avec un abonnement, sans clé API.

### Phase 4 : Agent de l'app web (4 à 5 jours)

1. `packages/llm` : registre de fournisseurs (Anthropic, OpenAI, Mistral, Gemini, Ollama, endpoint compatible OpenAI pour le gateway), un adaptateur par fournisseur avec tool calling unifié (par exemple l'AI SDK de Vercel) → verify : test qui échoue si un autre package importe un SDK de fournisseur.
2. Configuration des modèles (pattern PipesHub) : plusieurs fournisseurs, clé API chiffrée, nom du modèle, test de la clé à l'enregistrement, un modèle par défaut (pour Diametral, le gateway préconfiguré par variables d'environnement) → verify : une clé invalide est refusée, et changer le défaut change le modèle utilisé sans redémarrage.
3. `apps/agent` : prompt système construit depuis `core/` et du pack actif (doctrine, charte, voix) et le JSON Schema. Workflow repris de build-presentation : ingestion, storyline, challenge ciblé (une question à la fois, avec une recommandation), plan validé, construction, lint, QA visuelle → verify : un même brief avec 2 fournisseurs différents, les 2 decks à 0 erreur de lint.
4. Application des commentaires : `{ shape_id, texte }` vers un `patch_deck` → verify : 5 commentaires types (couleur, reformulation, déplacement, graphique, suppression) appliqués sans erreur de lint.

### Phase 5 : Interface (8 à 10 jours)

1. `apps/web` créé depuis `starters/vite-react` du design system, avec ses composants React uniquement → verify : la règle ESLint de la Phase 1 passe sur `apps/web`.
2. Écrans : liste des decks, éditeur (`slide-ui` + chat), historique des versions, choix du pack par deck, export PPTX → verify : parcours complet testé en Playwright.
3. **Paramètres > Modèles IA** (pattern PipesHub) : catalogue des fournisseurs, bouton Configurer, onglet Configurés, action Définir par défaut → verify : test Playwright qui configure 2 fournisseurs et bascule de l'un à l'autre.
4. **Paramètres > Brand packs** : import d'un `template.pptx`, revue de l'extraction (rôles, slides exclues, voix), validation, publication, upload des polices, plusieurs packs par espace de travail, visibilité par pack (espace de travail ou équipe, restreinte par défaut) → verify : test Playwright qui importe un template inconnu, assigne les rôles et obtient un deck conforme, et un utilisateur hors de l'équipe ne voit pas le pack.
5. Mode présentateur et authentification (thème Keycloak fourni par le design system) → verify : accès refusé sans session.

### Phase 6 : Déploiement (2 jours)

1. Images Docker (web, agent, engine) + `docker-compose.yml` → verify : `docker compose up`, puis un deck produit de bout en bout.
2. Déploiement sur l'infra interne (Argo/Tekton) avec une URL HTTPS joignable par Claude pour le connecteur → verify : URL, config OAuth et notice remises à l'IT, connecteur activé par l'IT dans Claude Team, un deck exporté depuis la recette.

## Terminé quand

- [ ] Un même deck se travaille via MCP depuis Claude Code ou Cowork avec un abonnement (sans clé API), et dans l'app web avec la clé d'un autre fournisseur.
- [ ] Une nouvelle entreprise s'installe en important son template, sans modifier le code, et obtient un deck conforme à sa charte.
- [ ] Un nouveau fournisseur de modèles se configure depuis la page Modèles IA, sans redéploiement.
- [ ] Une nouvelle version d'un pack (template ou tokens) se propage sans toucher au moteur.
- [ ] Le PPTX s'ouvre dans PowerPoint, tout y est éditable (textes, formes, graphiques), avec 0 erreur au lint.

**Décisions prises le 7 octobre 2026 :**

| Sujet | Décision | Impact dans le plan |
| --- | --- | --- |
| Connecteur Claude Team | Ajouté et administré par l'IT (un autre admin) | Phase 6 : remise à l'IT de l'URL, de la config OAuth et d'une notice |
| Visibilité des packs | Par pack : tout l'espace de travail ou une équipe. Restreinte par défaut à l'import. | Phases 3 et 5 : filtrage dans tous les outils, réglage dans la page Brand packs |
| Abonnement Claude dans l'app web | Pas de demande à Anthropic. L'abonnement passe par la porte MCP, l'app web reste en clé API. | Aucun |
| Gateway LLM Diametral | Compatible OpenAI avec tool calling | Phase 4 : fournisseur par défaut préconfiguré pour Diametral, par variables d'environnement |
| Polices des packs | Chaque entreprise uploade ses polices dans son pack, sous sa responsabilité de licence. Police de repli si absente. | Phases 1, 2 et 5 : dossier `fonts/` dans le pack, rendu avec les polices du pack |

## Sources

- [Design system Diametral](https://github.com/DiametralGroup/design-system) · [Marketplace de plugins Diametral](https://github.com/DiametralGroup/diametral-plugins-marketplace) (`visual-creation`, `pre-sales`)
- [MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) · [Agent SDK, authentification](https://code.claude.com/docs/en/agent-sdk/overview)
- [Presenton](https://github.com/presenton/presenton) · [templates TSX + Zod](https://docs.presenton.ai/v3/get-started/create-presentation-template-with-ai.md)
- [open-slide](https://github.com/1weiho/open-slide) · [docs](https://open-slide.dev/docs)
- [OpenDesign](https://github.com/nexu-io/open-design)
- [PipesHub](https://github.com/pipeshub-ai/pipeshub-ai) · [configuration des modèles](https://docs.pipeshub.com/ai-models/overview.md)
- [Benchmark slides agentiques](https://claude.ai/code/artifact/42ee4b5a-f805-40c9-ac30-31e16b4ad5a5)
