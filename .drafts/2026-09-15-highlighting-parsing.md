# Highlighting e parsing LaTeX/LilyPond: Implementation Plan

**Documento canonico versionato:** `.drafts/2026-09-15-highlighting-parsing.md`.
Per gli aggiornamenti usare questa copia e la specifica nella stessa directory.
Trasferimento richiesto dall'utente il 17 settembre 2026.

**Allineamento al 17 settembre:** l'utente ha autorizzato HP-03…HP-08 con commit
su `main` per ogni punto completato. HP-03 ha completato implementazione e
revisione ed è integrato in `c510f5b`: gate richiesto 38/38, controlli adiacenti
40/40, build/check riproducibili. HP-04 ha completato la revisione del parser
LaTeX e dell'highlighting montato; la selezione iniziale dei profili da estensione
`.sty/.cls` resta un collegamento esplicito da chiudere in HP-07.
HP-04 è integrato con `39da07c`. HP-05 ha completato implementazione e revisione
del parser musicale ed è integrato in `b0c6974`: gate 147/147, build/check
riproducibili. HP-06 ha completato revisione e attivazione del parser LilyPond,
con datum Scheme, musica annidata e test browser dei nuovi contesti, commit
`be005d9`. HP-07 ha completato la revisione dell'integrazione dei consumatori e
delle operazioni di editing; HP-08 resta la qualifica integrata e prestazionale.
La prova ha portato a una policy esplicita di
analisi limitata oltre 1.048.576 unità UTF-16; il limite e le latenze ordinarie
richiedono la qualifica nell'editor montato. La personalizzazione di temi/colori
e comandi è oggetto di valutazione architetturale per un seguito dopo HP-08,
senza anticiparne l'implementazione.

La [valutazione della personalizzazione](../docs/highlighting-customization.md)
documenta temi/palette e regole per comandi, i confini di configurazione e cache,
e un possibile HP-09 dopo HP-08. L'architettura offre i punti di estensione
necessari; questa valutazione non aggiunge la funzione al runtime.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Avviare l'implementazione dopo l'approvazione della proposta; eseguire i task in sequenza, con verifica a ogni consegna.

**Goal:** rendere leggibile e coerente il riconoscimento di LaTeX e LilyPond nell'highlighting e nelle funzioni editoriali che dipendono dalla sintassi.

**Architecture:** parser editoriali incrementali Lezer, adottati per linguaggio, con tag sintattici separati dalla palette. Un servizio browser usa l'albero CodeMirror per contesti e sintesi; indice, presenza, completion ed editing consumano questi dati.

**Tech Stack:** JavaScript/CommonJS nel progetto, nuovi moduli browser/test `.mjs`, CodeMirror 6, Lezer, CSS custom properties, `node:test`, Playwright Core.

**Spec:** [2026-09-15-highlighting-parsing-design.md](2026-09-15-highlighting-parsing-design.md). Leggere specifica e piano prima di eseguire i task.

## Global Constraints

- Node `>=24`; mantenere le versioni CodeMirror fissate in `package.json` salvo incompatibilità dimostrata.
- Dipendenze dirette proposte: `@lezer/common` 1.5.2, `@lezer/highlight` 1.2.3, `@lezer/lr` 1.4.10; sviluppo: `@lezer/generator` 1.8.0. Versioni esatte nel manifest e nel lockfile.
- Intervalli **UTF-16 `[from, to)`**, riferiti al documento CodeMirror effettivo. Nessuna normalizzazione del testo durante l'analisi.
- **4,5:1** per ciascun colore sintattico contro lo sfondo effettivo, nei temi chiaro/scuro e su selezione attiva/inattiva, ricerca, parentesi e presenza.
- Budget parser sincrono **5 ms**; sintesi con debounce **250 ms**, lavoro in tranche da **8 ms**.
- Prima qualifica LilyPond: `nederlands` predefinito, `italiano`, `english`, `deutsch`; sintassi di riferimento LilyPond 2.26.0.
- Parser locali nel browser; nessuna valutazione di macro TeX o codice Guile. Comandi sconosciuti e contesti incerti non equivalgono a errori di compilazione.
- Preservare transazioni granulari, undo, read-only, IME, multi-cursore e versioni collaborative.
- Classi legacy di BibTeX/RIS compatibili; il normalizzatore di completion usato dal server deve restare indipendente dai parser browser.
- La produzione usa parser generati già presenti. L'archivio sorgente deve includere grammatiche, tokenizer e cataloghi necessari alla rigenerazione.
- Copia UI EN/IT; mantenere l'editor centrato sul sorgente, senza toolbar di simboli pronti.

---

## 1. Sequenza e consegne

| Task | Consegna verificabile | Dipendenza |
| --- | --- | --- |
| HP-01 | Corpus, riproduzioni, baseline e test colori portabile | Nessuna |
| HP-02 | Palette qualificata e tassonomia comune; stringhe LilyPond distinte | HP-01 |
| HP-03 | Prova Lezer, generazione e distribuzione riproducibili | HP-01, HP-02 |
| HP-04 | Parser LaTeX con copertura TX-01…TX-09 | HP-03 |
| HP-05 | Parser LilyPond musicale con LY-01…LY-07 | HP-03 |
| HP-06 | Confini Scheme/LilyPond e recupero LY-08 | HP-05 |
| HP-07 | Indice, regioni, completion ed editing sul servizio comune | HP-04, HP-06 |
| HP-08 | Qualifica browser, performance, pacchetto e prova d'uso | HP-07 |

**Aggiornamento utente del 15 settembre:** sviluppo fortemente agentico;
l'avanzamento segue consegne, test e revisione, senza stime temporali. Esecuzione
autorizzata per HP-01 e HP-02 in worktree separato, con commit su `main` al
termine di ciascun punto verificato. HP-01 è integrato con `4d37c4e`, HP-02 con
`f6d8783`. La consegna tecnica dei due punti è completata; corpus reale e
accettazione visiva dell'utente restano attività di riscontro. Risultati e limiti:
[rapporto della sessione](highlighting-parsing-qualification.md).

HP-03 è il punto di decisione tecnico: promuovere Lezer se supera le prove su
contesti, recupero e costo; in caso contrario documentare il fallimento e
rivedere l'approccio con lo scanner condiviso della specifica e aggiornare le
dipendenze delle attività successive.

Ogni task termina con revisione del diff e risultati dei comandi indicati.
Creare commit solo se richiesti nel contesto di esecuzione; i confini dei task
sono anche possibili confini di commit. Nessun numero di release è assegnato.

## 2. Mappa dei file

Le directory `public/languages/`, `test/fixtures/languages/` e i moduli sotto
elencati sono nuovi. I percorsi degli altri file esistono nella base analizzata.

| File | Responsabilità |
| --- | --- |
| `public/iris-syntax-style.mjs` | Tag, mappatura ruoli/classi, compatibilità stream e highlighter per i test |
| `public/iris-language-service.mjs` | Caricamento adapter, analisi batch per test/file non aperti, query comuni |
| `public/iris-language-state.mjs` | Integrazione con `EditorState`, copertura parziale, revisioni, scheduling e cache |
| `public/languages/latex/latex.grammar` | Sintassi strutturale e contesti TeX |
| `public/languages/latex/tokens.mjs` | Tokenizer esterni e context tracker TeX |
| `public/languages/latex/catalog.mjs` | Ambienti, profili, firme di comandi, categorie degli argomenti |
| `public/languages/latex/queries.mjs` | Contesti, indice, regioni, simboli/riferimenti/include letterali |
| `public/languages/latex/editing.mjs` | Piani per Enter e indentazione, protezione dei literal |
| `public/languages/latex/index.mjs` | Factory `LanguageAdapter` LaTeX |
| `public/languages/latex/parser.mjs`, `parser.terms.mjs` | File generati da Lezer, mai modificati a mano |
| `public/languages/lilypond/lilypond.grammar` | Musica, configurazione, testo e isole Scheme |
| `public/languages/lilypond/tokens.mjs` | Contesti, stringhe, delimitatori e token musicali |
| `public/languages/lilypond/pitches.mjs` | Cataloghi dei nomi delle note e provenienza dei dati |
| `public/languages/lilypond/catalog.mjs` | Comandi, input mode, contesti, firme e proprietà riconosciute |
| `public/languages/lilypond/scheme-tokens.mjs` | Lettura dei confini Scheme e transizioni `#{…#}` |
| `public/languages/lilypond/queries.mjs`, `editing.mjs`, `index.mjs` | Query, piani di editing e factory LilyPond |
| `public/languages/lilypond/parser.mjs`, `parser.terms.mjs` | File generati |
| `scripts/build-languages.cjs` | Rigenerazione deterministica e modalità `--check` senza scritture |
| `test/helpers/language-fixtures.cjs` | Loader fixture annotate, controllo offset e raccolta dei ruoli |
| `test/helpers/language-browser.cjs` | Fixture dell'editor reale per i nuovi gate browser, con teardown |
| `test/fixtures/languages/cases.json` | Manifest dei casi, ruoli attesi, contesti, indice e provenienza |
| `test/fixtures/languages/latex-core.tex`, `latex-math.tex`, `latex-literal.tex`, `latex-macros.tex` | Corpus LaTeX |
| `test/fixtures/languages/lilypond-core.ly`, `lilypond-modes.ly`, `lilypond-scheme.ly`, `included.ily` | Corpus LilyPond |
| `test/fixtures/languages/README.md` | Sintassi di riferimento, origine e procedura per aggiungere casi |
| `test/fixtures/languages/lilypond-boundaries.grammar` | Grammatica ridotta della prova HP-03 sui confini Scheme/musica; fixture tecnica, non parser distribuito |
| `test/language-fixtures.test.js`, `language-build.test.js` | Integrità del corpus, generatori e pacchetto |
| `test/latex-language.test.js`, `lilypond-language.test.js`, `lilypond-scheme.test.js` | Contratti delle grammatiche |
| `test/language-state.test.js`, `language-editing.test.js` | Cache, revisioni, contesti ed edit |
| `test/language-highlighting.browser.test.js`, `language-performance.browser.test.js` | Resa montata, interazioni e tempi |
| `docs/editor-languages.md` | Contratto di supporto e limiti per utenti e manutentori |
| `.drafts/highlighting-parsing-qualification.md` | Risultati per task, baseline, macchina di benchmark e riscontro dell'utente |

**Integrazioni esistenti:** `public/iris-editor.js`, `iris-app.js`,
`iris-completion.js`, `iris-structure.js`, `iris-latex.js`, `iris-lilypond.js`,
`iris.css`, `Iris.html`, `public/locales/en/translation.json`, `public/locales/it/translation.json`,
`src/server.js`, `package.json`, `package-lock.json`, `scripts/release.cjs`,
`THIRD_PARTY_NOTICES.md`, `docs/ui-colors.md`, `docs/user-guide.md`,
`docs/development.md`, `docs/README.md`.

## 3. Contratti comuni da fissare in HP-03

I nomi seguenti sono le interfacce proposte, non API già presenti. Definire i
typedef JSDoc in `iris-language-service.mjs`; l'adapter editor conserva la sua
facciata `window.IrisEditor`.

```js
/** @typedef {'tex'|'ly'} Kind */
/** @typedef {'exact'|'recovered'|'unknown'} Certainty */
/** @typedef {{from:number,to:number}} Span */
/** @typedef {{length:number,sliceString(from:number,to:number):string}} Source */
/** @typedef {{initialNoteLanguage?:string,texProfile?:'standard'|'internal'|'expl3'}} ParseOptions */
/** @typedef {{kind:string,name:string,label:string,from:number,to:number,
 *   certainty:Certainty,openEnded:boolean,labelKey?:string,
 *   labelParams?:Object<string,string|number>}} Region */
/** @typedef {{level:number,num:string,title:string,offset:number,to:number,
 *   certainty:Certainty,titleKey?:string,titleParams?:Object<string,string|number>}} OutlineItem */
/** @typedef {{kind:'command'|'environment'|'variable'|'label',name:string,
 *   from:number,to:number,certainty:Certainty}} SymbolRecord */
/** @typedef {{kind:'command'|'variable'|'label'|'citation',name:string,
 *   from:number,to:number,certainty:Certainty}} ReferenceRecord */
/** @typedef {{path:string,from:number,to:number,certainty:Certainty}} IncludeRecord */
/** @typedef {{outline:OutlineItem[],regions:Region[],symbols:SymbolRecord[],
 *   references:ReferenceRecord[],includes:IncludeRecord[]}} SummaryData */
/** @typedef {SummaryData & {kind:Kind,revision:number,generation:number,
 *   status:'ready'|'partial'|'unavailable',parsedTo:number}} SyntaxSnapshot */
/** @typedef {{mode:'text'|'math'|'literal'|'comment'|'music'|'lyrics'|'markup'|
 *   'chords'|'drums'|'figures'|'scheme'|'string'|'unknown',
 *   argumentRole:string|null,from:number,to:number,certainty:Certainty}} CursorContext */
/** @typedef {{close:string,closingFrom:number|null,needsClose:boolean}|null} BlockPlan */
/** @typedef {{from:number,to:number,insert:string}} TextChange */
```

Esportazioni:

```js
// iris-language-service.mjs
// loadLanguage carica solo il modulo richiesto, con cache per Kind + ParseOptions.
loadLanguage(kind, options = {})             // Promise<LanguageAdapter>
analyze(kind, text, options = {}, {signal} = {}) // Promise<{tree, doc:Source, data:SummaryData}>

// Ogni LanguageAdapter: tutte queste funzioni lavorano su albero/doc correnti.
adapter.language                            // CodeMirror Language
adapter.summarize(tree, doc)                 // SummaryData; batch/test
adapter.contextAt(tree, doc, pos, bias = -1)  // CursorContext
adapter.blockAtEnter(tree, doc, pos)          // BlockPlan
adapter.formatChanges(tree, doc, range)      // TextChange[]; range Span|null

// iris-language-state.mjs
createLanguageState(adapter, onSyntax)       // {extension, read, contextAt, dispose}
// read(state) -> SyntaxSnapshot|null
// contextAt(state, pos, bias=-1) -> CursorContext, entro il budget
// onSyntax(snapshot) -> void; snapshot appartenente alla revisione/generazione attiva

// Estensione della facciata IrisEditor
syntaxSnapshot()                            // SyntaxSnapshot|null
onSyntax(fn)                                // registrazione con la convenzione degli eventi esistenti
```

Per il servizio di stato, la revisione viene dall'adapter editor; la generazione
cambia a ogni `load`/sostituzione del documento. Passare questi valori mediante
StateEffect/StateField al momento della transazione, evitando variabili globali
lette in un job successivo. La stessa revisione può ricevere più alberi via
avanzamento del parser; notificare la sintesi migliorata senza incrementare la
revisione del testo.

Gli array pubblici sono copie immutabili. `summarize()` è una query batch usata
nei test; il servizio di stato percorre gli stessi visitatori in tranche e
pubblica una sintesi solo dopo averne verificato copertura e identità.
`analyze()` usa `parser.startParse()`/`advance()` con scheduler a tranche e
`AbortSignal`, così i file non aperti non causano una scansione sincrona nel
percorso di completion. Cedere il controllo con un nuovo task del browser,
non con una catena di sole microtask. Il `doc` restituito conserva il testo
originale, comprese le code unit CR; nei test che montano CodeMirror fissare
`EditorState.lineSeparator.of('\n')` quando si vogliono conservare CRLF grezzi.

`title`/`label` contengono testo sorgente o fallback inglese stabile. Per un
titolo generato aggiungere `titleKey/titleParams` o `labelKey/labelParams`:
l'app traduce durante il rendering. Un cambio lingua UI ridisegna le etichette
senza riparsare il documento o cambiare il contesto dei nomi delle note.

---

## HP-01: corpus e baseline riproducibile

**File:** creare manifest, fixture e helper della mappa; creare
`test/language-fixtures.test.js`; modificare `test/ui-colors.test.js`.

**Consuma:** API attuali `IrisLatex.stream/outline/regions`,
`IrisLilyPond.stream/outline/regions`, casi dei test esistenti.

**Produce:** casi con ID TX/LY, annotazioni UTF-16 e riproduzioni confrontabili;
baseline dei gate e raccolta dei sorgenti d'uso.

- [x] Creare `.drafts/highlighting-parsing-qualification.md`, registrare i 59
  risultati della verifica iniziale e riprodurre il problema
  dei percorsi Windows con un caso che confronti percorsi normalizzati. Correggere
  nel walker la rappresentazione usata per le eccezioni, senza ampliare le
  eccezioni dei colori:

```js
const absolute = path.join(directory, entry.name);
const relative = path.relative(root, absolute).split(path.sep).join('/');
```

- [x] Aggiungere ai test del normalizzatore i percorsi
  `public/iris_logo.svg`, `public\\iris_logo.svg`, `src/collab.js` e
  `src\\collab.js`; un file UI ordinario con colore letterale deve continuare
  a fallire. Eseguire `node --test test/ui-colors.test.js` prima e dopo la modifica.

- [x] Inserire fixture annotate, con sorgente e aspettative separate. Definire
  `cases.json` come array di oggetti `{id, kind, file, roles, contexts, outline}`;
  `roles` contiene `{from,to,role}`, `contexts` `{pos,mode}`, `outline` i titoli.
  Caso minimo, senza cercare la stringa durante l'asserzione:

```json
{
  "id": "TX-02-comment-in-math",
  "kind": "tex",
  "file": "latex-math.tex",
  "roles": [{"from": 3, "to": 15, "role": "comment"}],
  "contexts": [{"pos": 17, "mode": "math"}],
  "outline": []
}
```

  Per questo caso il file contiene `$a % $ commento\nb$ testo` seguito da un
  newline: calcolare e controllare gli offset sul contenuto effettivo prima di
  accettare l'annotazione. Il loader deve rifiutare intervalli fuori file,
  sovrapposti per lo stesso livello di token o che spezzano una coppia surrogata.

- [x] Coprire ogni ID della specifica, includendo coppie positivo/negativo:
  comando reale/commentato, nota in musica/in lyrics, sezione reale/in literal,
  delimitatore Scheme in lista/in stringa. Conservare fixture corte per i
  prefissi e documenti composti per le prove d'uso.

- [x] Scrivere il test di integrità del manifest; l'asserzione chiave è:

```js
for (const span of fixture.roles) {
  assert.ok(Number.isInteger(span.from) && Number.isInteger(span.to));
  assert.ok(0 <= span.from && span.from < span.to && span.to <= source.length);
  const splitsPair = (pos) => pos > 0 && pos < source.length
    && /[\uD800-\uDBFF]/.test(source[pos - 1])
    && /[\uDC00-\uDFFF]/.test(source[pos]);
  assert.equal(splitsPair(span.from) || splitsPair(span.to), false);
}
```

- [x] Eseguire le riproduzioni sul parser attuale e registrare la distanza dalle
  aspettative in `test/fixtures/languages/README.md`. Le aspettative del nuovo
  parser diventano test obbligatori nei task che le implementano: non lasciare
  test fallenti o `skip` permanenti come dichiarazione di successo.
- [x] Preparare generatori sintetici con tagli esatti da 100 KiB, 1 MiB e 5 MiB,
  più una riga da 100 KiB, mantenendo distinti byte, code unit e righe. Registrare
  OS/browser di verifica e le misure della baseline.
- [ ] Integrare il corpus reale dell'utente quando disponibile. Il corpus
  iniziale comprende 21 sorgenti sintetici originali, dichiarati come tali.

**Verifica:**

```sh
node --test test/language-fixtures.test.js test/ui-colors.test.js test/editor-stream.test.js test/structure.test.js test/completion.test.js
```

**Uscita:** corpus tracciabile, nessuna nuova regressione, test colori corretto
su Windows e sul runner POSIX. La sola integrità degli offset non certifica
che i ruoli annotati siano corretti: rivederli sul sorgente.

## HP-02: tassonomia e prima consegna visiva

**File:** creare `public/iris-syntax-style.mjs`; modificare `iris.css`,
`iris-editor.js:77–100`, `iris-lilypond.js:17–43`,
`test/editor-stream.test.js`, `test/ui-theme.test.js`, `test/ui-colors.test.js`,
`test/ui-visibility.browser.test.js`, `docs/ui-colors.md`.

**Consuma:** corpus HP-01 e tabella ruoli della specifica.

**Produce:** `syntaxTags`, `syntaxClasses`, `legacyTokenTable`,
`roleHighlighter` e `syntaxExtension` esportati dal nuovo modulo.

- [x] Aggiungere un'aspettativa fallente: una stringa LilyPond deve avere ruolo
  `string`, mentre `\begin{align}` conserva `environment`. Non cambiare le
  aspettative bibliografiche che usano ancora `env`.
- [x] Definire tag condivisi una sola volta e classi senza colori nel JS:

```js
import {Tag, tagHighlighter} from '@lezer/highlight';
import {HighlightStyle, syntaxHighlighting} from '@codemirror/language';

const roles = ['command', 'structure', 'environment', 'context', 'definition',
  'variable', 'reference', 'citation', 'path', 'string', 'literal', 'lyric',
  'math', 'pitch', 'number', 'duration', 'rest', 'operator', 'articulation',
  'comment', 'delimiter', 'property', 'scheme'];
export const syntaxTags = Object.fromEntries(roles.map(role => [role, Tag.define()]));
export const syntaxClasses = Object.fromEntries(roles.map(role => [role, `t-${role}`]));
export const roleHighlighter = tagHighlighter(roles.map(role => ({tag: syntaxTags[role], class: role})));
export const syntaxExtension = syntaxHighlighting(HighlightStyle.define(
  roles.map(role => ({tag: syntaxTags[role], class: syntaxClasses[role]}))
));
```

  Definire `legacyTokenTable` con `cmd→command`, `env→environment`,
  `brace→delimiter`, `math→math`, `comment→comment`, `special→operator`,
  `string→string`. Conservare tag e classi separati per i quattro alias
  bibliografici `entryType/key/field/value` con le classi attuali `t-cmd/t-env/
  t-special/t-math`. Includere queste regole nello stesso `syntaxExtension`,
  così le loro tinte non cambiano come effetto collaterale degli alias TeX.

- [x] Cambiare soltanto i ritorni di stringa del tokenizer LilyPond da `env` a
  `string`. Aggiornare il corpus stream corrispondente. Importare lo stile
  nell'adapter editor durante il caricamento degli altri moduli ESM.
- [x] Estendere il walker e il ramo JavaScript di `test/ui-colors.test.js`
  anche a `.mjs`; provare che un colore UI letterale in un modulo ESM venga
  rilevato come nel corrispondente `.js`. Il server serve già `.mjs` con MIME
  JavaScript: aggiungere una verifica di caricamento del nuovo asset.
- [x] Introdurre i ruoli CSS della specifica e mantenere la convenzione esistente:

```css
:root {
  --syntax-string:var(--palette-amber);
  --syntax-pitch:var(--palette-green);
  --syntax-duration:var(--palette-orange);
  --syntax-structure:var(--syntax-command);
}
.t-string{color:var(--syntax-string)}
.t-pitch{color:var(--syntax-pitch)}
.t-duration{color:var(--syntax-duration)}
.t-structure{color:var(--syntax-structure);font-weight:600}
```

  Completare tutte le righe della tabella ruoli, preservando le classi legacy.
  Regolare le primitive sintattiche e il tema chiaro sulla base dei test montati;
  non usare l'opacità per abbassare il contrasto dei commenti.
- [x] Estendere le misure browser alle categorie emesse dagli stream, selezioni
  attive/inattive e overlay combinati, misurando gli span reali. Prequalificare
  i colori dei ruoli futuri su campioni CSS dichiarati come tali; HP-08 deve
  confermare quei ruoli sugli span prodotti dai nuovi parser. Un campione CSS
  non certifica il riconoscimento del costrutto.
- [x] Registrare palette iniziale qualificata e coppie critiche in `docs/ui-colors.md`.
- [ ] Eseguire il confronto visivo con l'utente su entrambi i temi e sui suoi
  sorgenti; distinguere questa accettazione dalle misure automatiche già superate.

**Verifica:**

```sh
node --test test/editor-stream.test.js test/ui-theme.test.js test/ui-colors.test.js
node scripts/test.cjs --browser test/ui-visibility.browser.test.js
```

**Uscita:** miglioramento visivo utilizzabile con i tokenizer attuali,
contrasto qualificato e stringhe distinte dagli ambienti. La copertura musicale
e matematica estesa arriva con HP-04/HP-05.

## HP-03: prova tecnica Lezer e catena di distribuzione

**File:** creare `scripts/build-languages.cjs`, `iris-language-service.mjs`,
`iris-language-state.mjs`, i moduli base di `public/languages/latex/`,
`test/language-build.test.js`, `test/language-state.test.js`,
`test/fixtures/languages/lilypond-boundaries.grammar`;
modificare manifest/lockfile, `Iris.html`, `src/server.js`,
`test/codemirror-vendor.test.js`, `scripts/release.cjs`,
`test/packaging.test.js`, `THIRD_PARTY_NOTICES.md`, `docs/development.md`.

**Consuma:** tag HP-02, API Lezer/CodeMirror delle versioni fissate.

**Produce:** interfacce del §3; supporto iniziale `tex` per gruppi, commenti,
literal e matematica sufficiente alla prova, senza attivazione in produzione.
`loadLanguage('ly')` entra nel registro solo in HP-05.

- [x] Aggiungere test fallenti per caricamento ESM in Node, generazione
  deterministica, file `.grammar` nel pacchetto e vendor `@lezer/lr`.
- [x] Aggiungere versioni esatte e script npm `build:languages` e
  `check:languages`. Usare API/CLI installati, senza risoluzione di pacchetti
  online durante build o avvio:

```json
{
  "build:languages": "node scripts/build-languages.cjs",
  "check:languages": "node scripts/build-languages.cjs --check"
}
```

  Il generatore legge i file `.grammar`, produce `parser.mjs` e
  `parser.terms.mjs` con import relativi corretti. `--check` genera in memoria,
  confronta con i file salvati e fallisce indicando ogni file diverso, senza
  sovrascriverlo. Provare esplicitamente i nomi `.mjs` prodotti dal generatore.
- [x] Aggiungere import map e whitelist vendor:

```json
"@lezer/lr": "/vendor/codemirror/lezer-lr.js"
```

```js
"lezer-lr.js": path.join(path.dirname(require.resolve('@lezer/lr')), 'index.js')
```

  Mantenere il modello di whitelist attuale e aggiornare entrambe le tabelle
  in `test/codemirror-vendor.test.js`.
- [x] Implementare il primo adapter come factory, con parser configurato dai
  tag condivisi; forma d'integrazione:

```js
import {LRLanguage} from '@codemirror/language';
import {styleTags} from '@lezer/highlight';
import {parser} from './parser.mjs';
import {syntaxTags as t} from '../../iris-syntax-style.mjs';

const configured = parser.configure({props: [styleTags({
  ControlWord: t.command,
  ControlSymbol: t.command,
  LineComment: t.comment,
  'OpenBrace CloseBrace': t.delimiter,
  LiteralText: t.literal
})]});
export const language = LRLanguage.define({
  parser: configured, languageData: {commentTokens: {line: '%'}}
});
```

  Questi sono i nomi dei nodi iniziali da definire nella grammatica. I file
  `tokens.mjs` e `catalog.mjs` gestiscono apertura/fine dei literal e stato
  matematico; introdurre subito il context hash per verificarne il riuso.
- [x] Prova di parità incrementale, da adattare al test del servizio:

```js
const {EditorState} = await import('@codemirror/state');
const {ensureSyntaxTree} = await import('@codemirror/language');
const {loadLanguage} = await import('../public/iris-language-service.mjs');
const adapter = await loadLanguage('tex');
let state = EditorState.create({doc: '\\section{A}\ntext', extensions: [adapter.language]});
ensureSyntaxTree(state, state.doc.length, 1000);
state = state.update({changes: {from: 0, insert: '% '}}).state;
const incremental = ensureSyntaxTree(state, state.doc.length, 1000);
assert.ok(incremental);
const full = adapter.language.parser.parse(state.doc.toString());
assert.equal(incremental.toString(), full.toString());
```

  Oltre alla forma dell'albero confrontare tutti i nodi con nome/from/to, ruoli
  e sintesi; `toString()` da solo non verifica gli offset. Ripetere per un
  delimitatore matematico e una chiusura literal cancellati e reinseriti.
- [x] Prima della decisione Lezer, compilare in memoria la grammatica di prova
  `lilypond-boundaries.grammar` nel test di build. Deve modellare `{…}`, liste
  `#(…)`, stringhe/commenti Scheme e musica `#{…#}`; usare come caso
  `#(define motif #{ c4 #})` e varianti con `)` in stringa e `#\)`.
  Verificare passaggi di contesto, cancellazione di `#}` e riuso dopo la
  riparazione. Registrare il risultato insieme alla prova TeX. Questa fixture
  serve a decidere la fattibilità; HP-05/HP-06 realizzano il parser completo
  del sottoinsieme dichiarato, con tutti i relativi test.
- [x] Implementare nel servizio di stato la gestione di copertura, budget e
  identità del §3. Se il parser non copre il cursore, restituire contesto
  `unknown`; pubblicare lo stato parziale senza cancellare dati validi di altre
  porzioni. Verificare i timer con scheduler controllato.
- [x] Estendere il filtro di `scripts/release.cjs` a `.grammar` nei percorsi
  previsti. Verificare che il pacchetto includa anche tokenizer/cataloghi `.mjs`
  e termini generati, e che il comando di rigenerazione funzioni senza `.git`.
- [x] Misurare il prototipo sui tre volumi del corpus e su modifiche in testa al
  file. Registrare risultati e decisione Lezer nel rapporto di qualifica e
  riportare la procedura nel documento di sviluppo.

**Verifica:**

```sh
npm run build:languages
npm run check:languages
node --test test/language-build.test.js test/language-state.test.js test/codemirror-vendor.test.js test/packaging.test.js
```

**Uscita:** recupero e riuso corretti, costo compatibile con gli obiettivi della
specifica e pacchetto rigenerabile. I parser possono ancora offrire copertura
ridotta, ma la prova deve includere i contesti difficili indicati.

## HP-04: parser LaTeX e copertura dei contesti

**Avanzamento:** implementazione e revisione completate il 17 settembre.
Corpus TX annotato e casi indipendenti verificati. Gate completo 124/124 e
browser mirato 6/6; dopo l'ultima correzione alle query, gate coprente 75/75.
La revisione ha incluso riuso reale dei sottoalberi, commenti negli header,
nomi personalizzati, codice differito nelle definizioni e lavoro limitato per
step/query. I consumatori legacy restano previsti per HP-07.

**File:** completare i moduli `public/languages/latex/`, creare
`test/latex-language.test.js`, aggiornare `test/editor-stream.test.js`,
`public/iris-editor.js` per l'attivazione del solo highlighting LaTeX.

**Consuma:** contratti HP-03, tag HP-02, fixture TX.

**Produce:** adapter TeX con grammatica e query TX-01…TX-09; il servizio espone
`data` da `analyze()` per test e futura migrazione dei consumatori.

- [x] Scrivere prima i test di protezione di commenti e literal. Esempio:

```js
const {analyze} = await import('../public/iris-language-service.mjs');
const source = '% \\section{Finta}\n\\begin{verbatim}\n\\section{Esempio}\n\\end{verbatim}\n\\section{Vera}';
const result = await analyze('tex', source);
assert.deepEqual(result.data.outline.map(item => item.title), ['Vera']);
assert.equal(result.data.regions.some(item => item.label === 'Esempio'), false);
```

- [x] Implementare gruppi, control word/symbol, commenti ed escape. I tokenizer
  contestuali devono consumare input oppure non accettare un token: nessun loop
  a lunghezza zero. Distinguere lettere normali, profilo interno e profilo expl3.
- [x] Implementare le quattro coppie matematiche e gli ambienti TX-03. Gestire
  `%` prima di cercare la chiusura matematica; `\text` crea un gruppo di testo
  che può contenere matematica annidata. Applicare tag ai figli, non a un nodo
  genitore con selettore che sovrascrive tutta la formula.
- [x] Implementare `verb` e ambienti TX-04, rispettando argomenti dell'apertura,
  escape e regole di chiusura proprie di ciascun ambiente. Le stringhe
  `\end{…}` in un corpo letterale devono seguire il suo delimitatore reale,
  non il matcher generale degli ambienti. Provare righe vuote e fine file.
- [x] Definire il catalogo delle firme con ruoli e contesti; schema iniziale:

```js
export const commandSignatures = {
  section: {star: true, optional: ['text'], required: ['heading'], rank: 3},
  ref: {star: true, optional: [], required: ['reference']},
  cite: {star: true, optional: ['text', 'text'], required: ['citation-list']},
  input: {star: false, optional: [], required: ['path']},
  text: {star: false, optional: [], required: ['text'], bodyMode: 'text'}
};
```

  Completare le firme delle famiglie TX-05…TX-08. I comandi sconosciuti
  conservano il nodo generico e i loro gruppi; non inventarne arità o effetti.
  Segnalare come `unknown` gli argomenti dinamici, riconoscendo almeno le forme
  braced di include richieste. Le forme TeX senza parentesi possono restare
  comando generico finché non hanno una fixture dedicata.
- [x] Estrarre indice e regioni dallo stesso albero, con titoli annidati,
  sette ranghi, stelle e argomenti brevi. Ignorare commenti/literal e corpi di
  definizione quando si estraggono elementi di documento. Gli ambienti chiusi
  male restituiscono regioni `recovered`, mai intervalli fuori documento.
- [x] Aggiungere raccolta di simboli, riferimenti e include letterali; verificare
  che macro/xparse mantengano i nomi già suggeriti dalla versione corrente.
  Includere dichiarazioni Unicode, `@`, `_`, `:` solo nel profilo corretto.
- [x] Confrontare ogni prefisso delle fixture corte e sequenze di riparazione
  con il parsing da zero. Aggiungere `\begin{a}\begin{a}…\end{a}`,
  `\begin{a}…\end{b}`, CRLF e caratteri astrali prima delle strutture.
- [x] Attivare l'adapter LaTeX nell'editor, mantenendo LilyPond/BibTeX/RIS sugli
  stream finché non arriva il loro task. Aggiornare i test del percorso montato:
  le aspettative nuove devono verificare i ruoli interni delle formule.

**Verifica:**

```sh
npm run build:languages
npm run check:languages
node --test test/latex-language.test.js test/editor-stream.test.js test/completion.test.js test/structure.test.js
```

**Uscita:** TX-01…TX-09 superati, highlighting attivo; prima di HP-07 indice e
completion possono ancora usare i percorsi legacy. Non qualificare la coerenza
dell'intero editor finché quei consumatori non sono migrati.

## HP-05: LilyPond musicale, testuale e di configurazione

**Avanzamento:** implementazione e revisione completate il 17 settembre.
Coperti i ruoli/contesti/indici annotati LY-01…07, la composizione di contesti e
wrapper, markup noto e firme numeriche, pause nelle percussioni e incertezza degli
include. I quattro cataloghi 2.26.0 comprendono 302 nomi verificati. Scheme generale
resta opaco/conservativo fino a HP-06; le arità markup sconosciute restano incerte.

**File:** creare/completare moduli `public/languages/lilypond/` salvo la parte
Scheme avanzata, creare `test/lilypond-language.test.js`; estendere servizio,
generatore e test di build al secondo linguaggio.

**Consuma:** HP-03, tag comuni e fixture LY.

**Produce:** adapter LilyPond con LY-01…LY-07; HP-06 ne completa i confini prima
dell'attivazione nell'editor.

- [x] Definire nel helper HP-01 `rolesFor(kind, source, options)` usando
  `analyze()` e `highlightTree(result.tree, roleHighlighter, callback)`, tutti
  importati come ESM per condividere le identità dei tag. Restituire un ruolo o
  `null` per ogni code unit. Primo test discriminante:

```js
const {rolesFor} = require('./helpers/language-fixtures.cjs');
const source = "{ cis'8. r4 }";
const roles = await rolesFor('ly', source);
assert.deepEqual(roles.slice(2, 6), Array(4).fill('pitch'));
assert.deepEqual(roles.slice(6, 8), Array(2).fill('duration'));
assert.equal(roles[9], 'rest');
assert.equal(roles[10], 'duration');
```

- [x] Implementare stringhe/commenti prima delle categorie musicali; aggiungere
  fixture che fissino il comportamento di `%{…%}` sulla versione di riferimento,
  anche in presenza di un'altra apertura nel corpo. Non importare implicitamente
  le regole dei commenti Scheme.
- [x] Costruire i quattro cataloghi dei nomi, alias e alterazioni da riferimenti
  versionati. Pubblicare `noteNames(language)` come `ReadonlySet<string>` o
  `null` per lingua sconosciuta; un tokenizer riconosce il nome intero, poi
  ottave/forzature. Aggiornare contesto e hash a `\language`.
- [x] Implementare durate numeriche e simboliche, punti e moltiplicatori;
  pause, accordi, `q`, polifonia, barre, legature/travature, articolazioni e
  dinamiche. La durata viene riconosciuta nella posizione musicale consentita,
  evitando di interpretare un numero di proprietà come durata.
- [x] Gestire input mode e firme dei wrapper. Caso negativo obbligatorio:

```js
const text = '\\lyricmode { do re mi }';
const roles = await rolesFor('ly', text);
assert.equal(roles.slice(text.indexOf('{') + 1, text.lastIndexOf('}')).includes('pitch'), false);
```

  Aggiungere analoghi casi per `markup`, `chordmode`, `drummode`, `figuremode`,
  proprietà, e un ritorno alla musica dopo la loro chiusura. Le parole dei testi
  rimangono testo anche se coincidono con nomi di note o pause.
- [x] Estrarre assegnazioni, include, contesti e blocchi dai nodi, con intestazioni
  multilinea e `\with` oltre 240 caratteri. Le variabili con nomi composti o
  quotati restano nell'indice; proporre come comando soltanto i nomi invocabili
  riconosciuti con certezza. Riutilizzare la stessa distinzione nei simboli.
- [x] Gestire `initialNoteLanguage`, provenienza locale e include secondo la
  specifica; aggiungere un `.ily` senza direttiva, lingua sconosciuta e cambio
  lingua nel mezzo del file. Niente risoluzione della lingua tramite locale UI.
- [x] Rigenerare e confrontare parsing incrementale/completo dopo cambi di
  `\language`, modo, commento e stringa. Espressioni Scheme ancora non
  qualificate restano in regioni conservative, senza azioni strutturali.

**Verifica:**

```sh
npm run build:languages
npm run check:languages
node --test test/lilypond-language.test.js test/lilypond-editor.test.js test/language-build.test.js
```

**Uscita:** musica e testo distinti, cataloghi verificati e struttura completa
dei casi LY-01…LY-07; HP-06 è necessario per qualificare sorgenti misti reali.

## HP-06: Scheme annidato e recupero dei contesti

**Avanzamento:** implementazione e revisione completate. Gate Node 165/165;
dopo le correzioni di confini degli atomi, storia delle direttive e proprietà
dei datum scartati, gate coprente 91/91 e browser mirato 8/8. Probe nativi su
LilyPond 2.26.0/Guile 3 confermano i casi del reader. Le estensioni non qualificate
restano incerte e opache; limiti dettagliati in `docs/editor-languages.md`.

**File:** creare `public/languages/lilypond/scheme-tokens.mjs`,
`test/lilypond-scheme.test.js`; modificare grammatica, tokenizer, query e
catalogo LilyPond; attivare il nuovo highlighting in `iris-editor.js`.

**Consuma:** adapter musicale HP-05.

**Produce:** LY-08, confini di datum e transizioni musica/Scheme qualificati.

- [x] Scrivere i casi che un semplice conteggio di parentesi sbaglia: `#\)`,
  stringa `")"`, commento `; )`, commento datum `#;`, quote e liste annidate.
  Inserire un comando LilyPond successivo per verificare il ritorno al linguaggio.
- [x] Implementare un lettore del confine del datum per `#`, `$`, `#@`, `$@`:
  liste/vettori, quote/quasiquote/unquote, booleani e atomi, caratteri, stringhe,
  commenti `;`, `#|…|#`, `#;`, `#!…!#`. Ogni commento deve consumare la forma
  prevista da Guile, con gestione della profondità solo dove prevista.
- [x] Inserire le produzioni Scheme nella grammatica LilyPond. Contratto del
  lettore esterno, interno al tokenizer:

```js
// Il reader non valuta l'espressione. Offset e stato restano nel parser.
// Contratto implementato in scheme-tokens.mjs:
// schemeIntroduction(input) -> [term, width]
// schemeToken(input, stack) -> accettazione di token limitati nell'InputStream
// La grammatica conserva i confini del datum e i figli; il context tracker
// immutabile e le query espongono completezza e certezza senza valutazione.
```

  Il lettore fornisce i confini; la grammatica conserva i nodi interni necessari
  a colorare atomi, numeri, stringhe e commenti. Evitare un token unico che
  nasconda i figli o una scansione monolitica senza limiti su un datum enorme.
  Suddividere stringhe/commenti lunghi in segmenti, lasciando al parser il
  controllo dei budget.
- [x] Trattare `#{…#}` come musica annidata con un proprio terminatore e ritorno
  al contesto Scheme. Definire nodi `SchemeExpression`, `SchemeString`,
  `SchemeComment`, `SchemeAtom`, `SchemeNumber`, `MusicLiteral`, e tag dei figli.
  La semplice presenza di `#}` in una stringa non chiude la musica.
- [x] Verificare la sequenza bidirezionale con ruoli e indice:

```js
const {analyze} = await import('../public/iris-language-service.mjs');
const {rolesFor} = require('./helpers/language-fixtures.cjs');
const source = '#(define motif #{ c4 d #})\n\\score { c1 }';
const result = await analyze('ly', source);
assert.equal(result.data.outline.some(item => item.title === 'Score 1'), true);
const roles = await rolesFor('ly', source);
assert.equal(roles[source.indexOf('c4')], 'pitch');
assert.equal(roles[source.indexOf('define')], 'scheme');
```

  Il titolo di fallback `Score 1` deve seguire la convenzione attuale; il parser
  puro può usare una chiave/dato strutturato internamente, ma la query pubblica
  deve produrre il titolo previsto dal contratto di test.
- [x] Definire il recupero: EOF in lista/stringa/commento produce incompletezza;
  un reader sconosciuto rende incerto il contesto; la prima chiusura compatibile
  ristabilisce il livello esterno. Non interpretare `%` come commento LilyPond
  quando il reader Scheme è attivo.
- [x] Provare cancellazione/reinserimento di ogni delimitatore, passaggi annidati
  e modifica remota prima dell'isola. Confrontare alberi, ruoli e query con il
  parsing da zero. Attivare LilyPond nell'editor dopo questa verifica.

**Verifica:**

```sh
npm run build:languages
npm run check:languages
node --test test/lilypond-language.test.js test/lilypond-scheme.test.js test/editor-stream.test.js
```

**Uscita:** nessuna fuga di contesto nei casi Scheme dichiarati; codice
sconosciuto trattato come incerto senza compromettere la digitazione.

## HP-07: migrare i consumatori e il ciclo di vita

**Avanzamento al 18 settembre:** implementazione ripresa dopo un'interruzione,
completata e revisionata. Unico owner per documento, profili `.sty/.cls`, indice e
presenza da snapshot, completamento asincrono con cache e invalidazione, Enter/
pairing/formatting dall'albero; rimossi i moduli legacy LaTeX/LilyPond.
Gate 66/66 Node mirati, 384/384 integrazione/project-client/browser, 199/199
salvaguardie e 8/8 browser preesistenti. Le ultime correzioni della completion
sono coperte da 23/23 Node e 15/15 browser mirati; tutte le findings chiuse.
Formatting sincrono conservativo: massimo 65.536 unità, 4.096 righe, 32.768 nodi,
deadline di pianificazione 8 ms. Il rifiuto conserva il sorgente e non equivale
a formattazione applicata. Prestazioni effettive e qualifica completa restano HP-08.

**File:** `iris-language-service.mjs`, `iris-language-state.mjs`,
`public/languages/latex/editing.mjs`, `public/languages/lilypond/editing.mjs`,
`iris-editor.js`, `iris-app.js`, `iris-completion.js`, `iris-structure.js`,
`iris-latex.js`, `iris-lilypond.js`, `iris.css`, `public/locales/en/translation.json`,
`public/locales/it/translation.json`; creare `test/language-editing.test.js` ed estendere
`language-state.test.js`, `structure.test.js`, `completion.test.js`,
`completion.integration.test.js`, `collab-client.test.js`.

**Consuma:** entrambi gli adapter completi.

**Produce:** un'unica sintesi attiva per indice/presenza; contesto condiviso con
completion/pairing/Enter; protezione delle porzioni letterali nel formatter.

- [x] Prima scrivere i test sulle sintesi obsolete: richiesta su A, cambio a B,
  fine della richiesta A; modifica locale e remota durante un job; avanzamento
  del parser senza `docChanged`. Solo il risultato appartenente a B/revisione
  corrente può essere pubblicato. Usare timer controllati, non sleep arbitrari.
- [x] Integrare gli StateField del servizio nell'adapter. Usare
  `syntaxTree(state)`, copertura e avanzamento a budget di CodeMirror; ricostruire
  le query solo a identità albero/documento diversa. Esempio di guardia del job:

```js
const ownsResult = (started, current) => started.generation === current.generation
  && started.revision === current.revision
  && started.kind === current.kind;
```

  Catturare `started` all'avvio; rivalidare prima della pubblicazione. Su load
  incrementare generation, annullare i job e svuotare le cache incompatibili.
  Il confronto non deve usare solo il percorso del file.
- [x] Sostituire `renderOutline()` e `rebuildStructure()` in `iris-app.js` con
  lettura/subscription della sintesi. Durante il caricamento mantenere una vista
  coerente con lo stato `partial/unavailable`, con copia EN/IT se occorre; non
  eseguire una regex di fallback che produca struttura discordante.
- [x] Aggiungere `IrisStructure.fromRegions(regions, length)` come ingresso
  pubblico al costruttore esistente; migrare l'app a questo ingresso. Rendere
  half-open il containment, con eccezione esplicita per EOF di regioni aperte.
  Testare due sezioni adiacenti e presenza sul loro confine:

```js
const tree = IrisStructure.fromRegions([
  {kind: 'section', label: 'A', from: 0, to: 10, openEnded: false},
  {kind: 'section', label: 'B', from: 10, to: 20, openEnded: true}
], 20);
assert.equal(IrisStructure.pathAt(tree, 10).at(-1).label, 'B');
assert.equal(IrisStructure.pathAt(tree, 20).at(-1).label, 'B');
```

  Conservare `openEnded` nel tree builder. Per label UI mantenere la
  localizzazione corrente, in particolare i titoli fallback delle partiture,
  usando le chiavi/dati del §3. Includere un cambio EN/IT a sintesi invariata.
- [x] Modificare la source di completion per ricevere contesto/sintesi dal
  servizio invece di `completionText(prefix)`. Mantenere il normalizzatore
  CommonJS e la firma pubblica della sua parte server. La sorgente browser può
  restituire una Promise secondo l'API CodeMirror, con scarto delle richieste
  superate. Conservare cache valide dei file non aperti e ricalcolare soltanto
  i file cambiati; escludere file generati, cancellati e del progetto precedente.
- [x] Alimentare i cataloghi di completion con i dati dei linguaggi, mantenendo
  comandi personalizzati e citazioni BibTeX. Estrarre i termini dalle sintesi,
  conservando la provenienza del file. Completare riferimento/citazione solo
  nell'argomento previsto dalla firma e con contesto affidabile.
- [x] Migrare Enter/pairing mantenendo le transazioni dell'editor. Il test di
  base per il piano deve verificare la prenotazione della chiusura esterna:

```js
const {loadLanguage, analyze} = await import('../public/iris-language-service.mjs');
const source = '\\begin{a}\n\\begin{a}\n\\end{a}';
const adapter = await loadLanguage('tex');
const {tree, doc} = await analyze('tex', source);
const pos = source.indexOf('\n\\end');
assert.equal(adapter.blockAtEnter(tree, doc, pos).needsClose, true);
```

  Aggiungere test montati con due cursori, selezione non vuota, coppia inline,
  auto-indent spento, IME e viewer. Per i piani da destra a sinistra aggiornare
  uno stato temporaneo con il ChangeSet già calcolato; non interrogare l'albero
  della stringa originale con offset del testo cambiato. In contesto incerto
  inserire solo newline/indentazione della riga senza chiusure aggiuntive.
- [x] Implementare `formatChanges()` come elenco di edit dell'indentazione,
  proteggendo gli intervalli literal/string/Scheme non qualificato. Testare
  identità byte-per-byte del corpo protetto, idempotenza e undo singolo:

```js
const source = '\\begin{verbatim}\n  a  \n\n\n b\n\\end{verbatim}';
const adapter = await loadLanguage('tex');
const result = await analyze('tex', source);
const changes = adapter.formatChanges(result.tree, result.doc, null);
const bodyFrom = source.indexOf('\n') + 1;
const bodyTo = source.lastIndexOf('\\end');
assert.equal(changes.some(change => change.from < bodyTo && change.to > bodyFrom), false);
```

  Verificare anche inserimenti a lunghezza zero dentro il corpo protetto e
  risultato finale, perché il solo controllo di sovrapposizione sopra non li
  esclude. Rendere il formatter conservativo sui nodi recuperati.
- [x] Dopo parità dei consumatori eliminare i percorsi duplicati
  `outline/regions/completionText/blockAtEnter` e i tokenizer TeX/LilyPond
  obsoleti, oppure ridurre le facciate a wrapper del servizio dove esistono
  ancora chiamanti. Aggiornare script order e test vendor soltanto dopo aver
  verificato tutti i chiamanti. I test devono esercitare il percorso nuovo,
  non un parser legacy ormai scollegato dall'editor.

**Verifica:**

```sh
node --test test/language-state.test.js test/language-editing.test.js test/structure.test.js test/completion.test.js test/codemirror-vendor.test.js
node scripts/test.cjs test/completion.integration.test.js test/collab-client.test.js test/source-navigation-client.test.js
```

**Uscita:** commenti, literal e contesti hanno identica interpretazione nei
consumatori; cache e intervalli non sopravvivono al documento sbagliato; editing
e collaborazione mantengono le garanzie esistenti.

## HP-08: qualifica integrata, performance e documentazione

**File:** creare helper browser e due suite browser della mappa,
`docs/editor-languages.md`; aggiornare `docs/user-guide.md`, `docs/ui-colors.md`,
`docs/development.md`, `docs/README.md`, eventuali aspettative in
`test/source-navigation.browser.test.js`, `test/bibliography.browser.test.js`.

**Consuma:** HP-07 e obiettivi numerici della specifica.

**Produce:** rapporto di qualifica, istruzioni di manutenzione e corpus accettato.

- [ ] Costruire l'helper sull'editor reale e sui pattern di
  `test/ui-visibility.browser.test.js`: import map, asset locali, selezione,
  trasporto controllato, cleanup con scadenze. Tenere le nuove suite focalizzate
  sui linguaggi senza copiare l'intera suite UI.
- [ ] Verificare nel DOM le classi su token esistenti, cambio lingua/file/tema,
  testo errato e poi riparato, selezioni e overlay. Misurare il contrasto
  composito per ogni ruolo attivo e preservare la posizione di lettura del PDF
  durante il cambio tema e gli aggiornamenti della sintassi.
- [ ] Provare la coerenza fra classe del token, contesto al cursore, indice e
  completion sui casi fittizi commentati/letterali. Inviare modifiche remote
  attraverso il percorso collaborativo reale del client; verificare che un
  aggiornamento solo dei peer non faccia ripartire il parsing.
- [ ] Implementare misure input-to-render nel browser, distinguendo il tempo
  trascorso dalla callback di parsing. Usare un `requestAnimationFrame` successivo
  alla comparsa della classe attesa; conservare tutte le misure e calcolare p95:

```js
const percentile95 = samples => {
  const sorted = samples.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
};
assert.ok(percentile95(samples100KiB) <= 50);
assert.ok(percentile95(samples1MiB) <= 100);
```

  Raccogliere 20 campioni dopo 5 warm-up, almeno per edit locale, remoto e cambio
  di contesto in testa. Registrare macchina/browser e separare warm/cold.
  Applicare soglie solo al runner qualificato; i test funzionali devono restare
  deterministici anche su macchine più lente. Se il budget fallisce, profilare
  lexer, query, conversioni di stringhe e rendering prima di proporre un worker.
- [ ] Qualificare prima viewport ≤ 200 ms, sintesi entro 500 ms dopo pausa su
  1 MiB, tranche ≤ 8 ms e budget sincrono 5 ms. Cercare long task > 50 ms,
  file da 5 MiB, riga da 100 KiB e 100 cambi file. Controllare cache e heap dopo
  GC disponibile nel runner: nessuna crescita proporzionale ai file chiusi.
- [ ] Sul sottoinsieme valido delle fixture eseguire LaTeX/LilyPond nativi per
  verificare la sintassi degli esempi; ripetere i gate di navigazione dato il
  cambiamento di offset e ciclo di vita. Non richiedere che le fixture incomplete
  compilino, né usare il successo del compilatore come test dell'highlighting.
- [ ] Provare l'archivio sorgente estratto: parser già disponibili con dipendenze
  di produzione; rigenerazione identica dopo installazione delle dipendenze di
  sviluppo; tutti gli asset caricati senza CDN o file provenienti dal checkout.
- [ ] Documentare tabella di supporto TX/LY, aggiunta di costrutti con fixture,
  aggiornamento cataloghi, interpretazione di `partial/unknown`, convenzioni
  delle note, limiti di TeX dinamico e differenza fra analisi editoriale e build.
- [ ] Sessione finale con l'utente sui sei sorgenti; registrare problemi residui
  per costrutto e criterio, con priorità. Una regressione P0 su commenti/literal,
  note/durate, corruzione degli edit o perdita di coerenza dei documenti blocca
  l'adozione del nuovo parser interessato.

**Comandi di qualifica:**

```sh
npm run check:languages
node scripts/test.cjs
node scripts/test.cjs --browser test/language-highlighting.browser.test.js test/language-performance.browser.test.js test/ui-visibility.browser.test.js test/bibliography.browser.test.js test/browser-lifecycle.browser.test.js
node scripts/test.cjs --browser test/source-navigation.browser.test.js
node scripts/test.cjs --native test/source-mapping.native.test.js
```

Il runner `scripts/test.cjs` crea PostgreSQL usa-e-getta e richiede l'ambiente
POSIX documentato. I gate browser richiedono Chrome/Chromium; i gate di
navigazione browser e nativi richiedono anche i compilatori. Su Windows eseguire
i test puri con `node --test`; usare WSL o il runner POSIX qualificato per gli
altri gate. Non conteggiare suite disabilitate o prerequisiti assenti come PASS.

## 4. Matrice di chiusura

| Requisito | Task | Evidenza richiesta |
| --- | --- | --- |
| Contrasto e distinzione visiva | HP-02, HP-08 | Misure montate + revisione del corpus utente |
| TX-01…TX-09 | HP-04 | Fixture annotate, contesti, nodi e offset |
| LY-01…LY-07 | HP-05 | Ruoli musicali/testuali, lingua note, header lunghi |
| LY-08 | HP-06 | Datum Scheme, isole musicali, recupero e ritorno al contesto |
| Incrementalità ed error recovery | HP-03…HP-06 | Parità con parse completo dopo sequenze di edit |
| Unificazione indice/presenza/completion | HP-07 | Test integrati su commenti, literal, simboli e confini |
| Enter, pairing, formatter | HP-07 | Multi-cursore, undo, read-only, IME, porzioni protette |
| Revisioni, Unicode, collaborazione | HP-03, HP-07, HP-08 | Risultati obsoleti scartati, CRLF/astrali, update remoti |
| Budget e documenti grandi | HP-08 | Distribuzioni dei tempi, long task, cache dopo cambi file |
| Vendoring, licenze, packaging | HP-03, HP-08 | Import map/whitelist, notices, rigenerazione da archivio |
| Documentazione e manutenzione | HP-08 | Supporto dichiarato, fixture riproducibili, comandi di qualifica |

## 5. Confini della consegna e passaggio successivo

L'adozione definitiva richiede i criteri HP-08 per entrambi i linguaggi. Durante
lo sviluppo usare una selezione interna del parser per le prove comparative;
non aggiungere una preferenza permanente di progetto. Il ritorno alla versione
precedente deve riguardare l'intero adapter del linguaggio, inclusi i consumatori,
evitando colori nuovi e indice vecchio come assetto stabile.

I dati `symbols/references/includes` preparano il successivo indice di progetto.
La futura specifica per navigazione/rinomina dovrà affrontare include, entry
point, scope, definizioni duplicate e nomi dinamici. Folding e diagnostiche
locali richiedono a loro volta una decisione di prodotto e test dedicati. Nessuna
di queste estensioni è necessaria per chiudere gli otto task di questo piano.
