# Highlighting e parsing LaTeX/LilyPond: proposta

**Documento canonico versionato:** `.drafts/2026-09-15-highlighting-parsing-design.md`.
Per gli aggiornamenti usare questa copia e il piano nella stessa directory.
Trasferimento richiesto dall'utente il 17 settembre 2026.

**Decisione tecnica in qualifica HP-03:** i servizi applicano un limite di
1.048.576 unità UTF-16 per l'analisi completa sul thread principale. Oltre il
limite restituiscono analisi non disponibile e contesti conservativi, consentendo
l'editing neutro. Il dato non equivale a un documento analizzato vuoto. Questa
policy concretizza la modalità limitata dei casi di stress da 5 MiB; le soglie
ordinarie di latenza restano obiettivi da verificare in HP-08. I chiamanti editor
e completion dovranno installare il linguaggio attraverso la guardia condivisa.

**Data:** 15 settembre 2026.

**Stato:** HP-01 e HP-02 implementati e integrati su `main` il 15 settembre 2026,
con commit `4d37c4e` e `f6d8783`. Il riscontro visivo e il corpus reale dell'utente
restano aperti. HP-03 è integrato con `c510f5b`; HP-04 ha completato la revisione
di parser e highlighting LaTeX. HP-05…HP-08 sono autorizzati e restano da eseguire.
La scelta automatica del profilo TeX da `.sty/.cls` rientra nell'integrazione HP-07.

**Base analizzata:** Iris 1.0.1, commit `0402762`.

**Priorità proposta:** alta nel backlog R11, in risposta alla rilevanza indicata dall'utente.

**Piano:** [attività e verifiche](2026-09-15-highlighting-parsing.md).

## 1. Risultato atteso per chi scrive

Chi scrive un documento o una partitura deve poter distinguere il contenuto dalla
sintassi, capire in quale contesto si trova e continuare a lavorare mentre il
sorgente è incompleto. Iris deve riconoscere allo stesso modo un commento, un
ambiente o un blocco musicale quando colora il testo, costruisce l'indice e
propone un completamento.

Propongo due consegne:

1. **Leggibilità:** rivedere la palette sui sorgenti reali, separare le stringhe
   LilyPond dagli ambienti LaTeX, verificare selezioni e sovrapposizioni. Rendere
   visibile un primo miglioramento senza attendere entrambi i nuovi parser.
2. **Riconoscimento affidabile:** introdurre parser incrementali Lezer per i due
   linguaggi e usare i loro risultati per highlighting, indice, regioni
   collaborative e contesto di completamento. Qualificare anche Enter e la
   protezione del testo letterale durante la formattazione.

Il traguardo comprende sintassi editoriale e struttura. La verifica del risultato
tipografico o musicale continua a dipendere dai compilatori. Rinomina di simboli,
controllo cross-file dei riferimenti e navigazione semantica richiedono il
successivo indice di progetto già previsto in R11.

## 2. Stato attuale verificato

| Area | Evidenza nel codice | Conseguenza per l'utente |
| --- | --- | --- |
| Highlighting | `public/iris-editor.js:77–100`: `StreamLanguage`, sei categorie principali per TeX/LilyPond | Il sistema distingue pochi ruoli; le categorie bibliografiche condividono parte della mappatura. |
| LaTeX matematico | `public/iris-latex.js:11–27`: consumo del contenuto fino al delimitatore di chiusura | Comandi, numeri e operatori di una formula hanno un unico colore; i commenti dentro la matematica non hanno il loro contesto. |
| LaTeX letterale | `environmentTokens()` conosce `verb`, `verbatim`, `minted` e altri ambienti; `stream`, `outline()` e `regions()` seguono percorsi diversi | Il completamento può ignorare correttamente un esempio letterale mentre l'indice lo interpreta come struttura. |
| Indice LaTeX | `outline()` riconosce `section` e `subsection` con una regex; `regions()` conosce sette livelli e parentesi annidate | Capitoli, titoli complessi e commenti possono produrre risultati discordanti. |
| LilyPond | `public/iris-lilypond.js:6–55`: comandi, stringhe, commenti, `{}` e `<< >>` | Note, pause, durate, accordi e articolazioni restano in gran parte testo normale. Le stringhe usano `env`. |
| Struttura LilyPond | `outlineSource()`, `outline()`, `scanBlockSpans()` e ricerca dell'apertura con `HEADER_LIMIT = 240` | I casi comuni funzionano; intestazioni lunghe e passaggi a Scheme dipendono da euristiche. |
| Completamento | `public/iris-completion.js:64–143`: scansione del prefisso e regex sui file, con cache per contenuto/percorso | Esistono già suggerimenti di progetto; il loro riconoscimento va allineato al parser. |
| Aggiornamenti | `public/iris-app.js:482–500` e `1637–1668`: ricostruzione delle regioni a 250 ms, indice separato | Più consumatori possono ripercorrere lo stesso testo. Il costo effettivo richiede un benchmark. |
| Colori | `public/iris.css`, `docs/ui-colors.md`, test Node e browser | Esiste già il contratto di contrasto 4,5:1. Serve verificare anche la distinzione percettiva tra categorie. |

### Riproduzioni sul codice corrente

- `% \section{Finta}` compare nell'indice insieme alla sezione reale.
- Una `\section{Finta}` dentro `verbatim` compare nell'indice e nelle regioni.
- Nel sorgente seguente il tokenizer chiude la matematica sul `$` commentato,
  poi tratta `testo` come matematica:

```tex
$a % $ commento
b$ testo
```

- In `{ c4 d8 r2 <c e g>1 }` il tokenizer assegna una categoria soltanto alle
  parentesi graffe; note, durate, pause e accordo restano senza categoria.

Questi casi sono riproduzioni, non un censimento di tutti i difetti. I test
esistenti verificano i comportamenti previsti finora, compresa la colorazione
uniforme delle formule: il piano aggiorna quelle aspettative con casi annotati.

### Verifica iniziale

Esecuzione su Windows, Node `v24.20.0`:

```sh
node --test test/editor-stream.test.js test/lilypond-editor.test.js test/structure.test.js test/completion.test.js test/ui-colors.test.js test/ui-theme.test.js test/codemirror-vendor.test.js
```

Risultato: **59 test, 58 superati, 1 fallito**. Il test fallito è
`first-party runtime colors are palette primitives or individually documented exceptions`.
In `test/ui-colors.test.js:81–87`, `path.relative()` restituisce percorsi Windows
con `\`, confrontati con eccezioni scritte con `/`: il test segnala loghi e colori
dei peer che intende escludere. Un confronto isolato conferma la causa. La
normalizzazione dei percorsi del test entra in HP-01; il risultato non dimostra
una regressione della palette. In questa analisi non sono stati eseguiti i gate
browser, nativi o PostgreSQL.

## 3. Alternative architetturali

| Approccio | Benefici | Costi e limiti | Valutazione |
| --- | --- | --- | --- |
| **Lezer incrementale con adozione per linguaggio** | Integrazione con CodeMirror 6, alberi riutilizzabili, recupero degli errori, contesto comune per i consumatori | Grammatiche e tokenizer contestuali da mantenere; TeX e Scheme richiedono confini espliciti | **Raccomandato.** Adatto all'evoluzione dell'editor e alle future funzioni sui simboli. |
| Estendere `StreamLanguage` e introdurre uno scanner strutturale condiviso | Primo miglioramento più rapido, poche dipendenze | Incrementalità strutturale da costruire; rischio di mantenere due interpretazioni della sintassi | Alternativa se la prova tecnica di Lezer non raggiunge i criteri stabiliti. |
| Tree-sitter/WASM o language server | Possibile riuso di grammatiche e servizi di altri editor | Adattamento a CodeMirror, runtime aggiuntivo, offset, distribuzione; un LSP aggiunge processi e sincronizzazione | Da valutare con un bisogno dimostrato di servizi semantici avanzati. |

Lezer non rende completo il parsing di TeX. Si propone una grammatica editoriale
tollerante: gruppi, contesti, comandi e argomenti riconoscibili senza espansione
di macro. Per LilyPond si distinguono musica, testo, proprietà e Scheme senza
eseguire Guile. La prova tecnica deve verificare queste due ipotesi prima di
investire nella copertura estesa.

## 4. Contratto di highlighting

### 4.1 Categorie e resa

Separare tre livelli: **tipo di nodo/token → ruolo sintattico → classe e token
CSS**. Un ruolo ha un significato stabile, anche se due ruoli condividono una
famiglia cromatica. I colori delle categorie applicative e degli stati non
devono dipendere dai colori del sorgente.

| Ruolo | Esempi | Direzione visiva proposta |
| --- | --- | --- |
| `command` | `\usepackage`, comando sconosciuto `\miaMacro` | Blu, peso normale |
| `structure` | Comandi di sezione, `\score`, `\book`, `\new` | Blu, peso 600 |
| `environment`, `context` | `align`, `figure`, `Staff`, `Voice` nelle rispettive posizioni | Viola |
| `definition`, `variable` | Nome definito, riferimento a variabile musicale | Ciano; peso 600 soltanto sulla definizione |
| `reference`, `citation`, `path` | Chiavi di `\ref`, `\cite`, argomenti di include | Ciano; ruoli separati nel modello |
| `string`, `literal`, `lyric` | Stringhe LilyPond, `\verb`, testo cantato | Ambra o neutro caldo; testo leggibile anche su blocchi lunghi |
| `math`, `pitch` | Identificatori matematici, altezza scritta della nota | Verde; ruoli separati |
| `number`, `duration` | Numero matematico, `8.`, `*3/2` di una durata | Arancio |
| `rest` | `r`, `R`, `s` in musica | Viola, distinto dall'altezza |
| `operator`, `articulation` | `^`, `_`, legature, staccato, forcelle | Accento caldo; mantenere leggibili i simboli piccoli |
| `comment` | Commenti del linguaggio attivo | Neutro secondario, con contrasto da testo normale |
| `delimiter` | Gruppi, delimitatori matematici, accordi, simultaneità | Neutro più evidente del commento |
| `property`, `scheme` | `NoteHead.color`, identificatori Scheme | Viola/ciano secondo il ruolo interno |

Il testo ordinario resta `--syntax-text`. Non colorare ogni parola negli
argomenti come parametro: il contenuto di `\section{Testo}` e di
`\textbf{Testo}` rimane testo, con i comandi annidati riconosciuti.

Usare i ruoli esistenti quando il significato coincide; introdurre
`--syntax-string`, `--syntax-definition`, `--syntax-variable`,
`--syntax-reference`, `--syntax-citation`, `--syntax-path`, `--syntax-pitch`,
`--syntax-duration`, `--syntax-rest`, `--syntax-operator`, `--syntax-articulation`,
`--syntax-property`, `--syntax-scheme`, `--syntax-literal`, `--syntax-lyric`,
`--syntax-context` e `--syntax-structure`. Le primitive nuove, se necessarie,
devono appartenere alla palette sintattica, senza alterare pulsanti e stati.
Le classi legacy di BibTeX/RIS mantengono la loro mappatura durante la migrazione.

Le famiglie cromatiche sono una proposta iniziale, non valori esadecimali già
qualificati. HP-02 produce i valori definitivi attraverso misure nel browser e
una revisione con l'utente su sorgenti campione.

### 4.2 Criteri visivi

- **4,5:1** per ciascun colore sintattico contro lo sfondo effettivo, nei temi
  chiaro/scuro e su selezione attiva/inattiva, ricerca, parentesi e presenza.
- Verificare i colori dei glifi e la composizione degli sfondi degli antenati,
  come richiede già `docs/ui-colors.md`.
- Valutare insieme le coppie critiche: comando/testo, commento/delimitatore,
  stringa/ambiente, nota/durata, nota/pausa. Il contrasto col fondo non misura la
  differenza tra queste coppie. Annotare i confronti in visione normale e con
  simulazioni di protanopia/deuteranopia, senza dichiarare tali simulazioni una
  garanzia di accessibilità.
- Usare peso e sintassi visibile come indizi aggiuntivi. Riservare sottolineature
  e bande alle interazioni, alla presenza e alle diagnostiche; evitare rumore
  visivo e cambi di altezza della riga.
- Cambio tema tramite CSS, con stessa istanza editor, selezione, cronologia,
  posizione di scorrimento e stato collaborativo.

## 5. Copertura funzionale

### 5.1 LaTeX

| ID | Copertura richiesta | Aspettativa verificabile |
| --- | --- | --- |
| TX-01 | Control word/symbol, escape, `%`, gruppi annidati, argomenti opzionali, comandi con stella | `\%` resta escape; `%` apre un commento solo fuori da zone letterali. Gli argomenti incompleti mantengono la parte riconosciuta. |
| TX-02 | `$…$`, `$$…$$`, `\(…\)`, `\[…\]` | Separare delimitatori, comandi, identificatori, numeri, operatori e commenti. Ripristinare il contesto dopo la chiusura. |
| TX-03 | `math`, `displaymath`, `equation`, `align`, `alignat`, `flalign`, `gather`, `multline`, `eqnarray`, versioni stellate; `aligned`, `alignedat`, `gathered`, `split`, `cases`, `array` e famiglie `matrix` | Applicare il contesto matematico agli ambienti riconosciuti; `\text{…}` torna a testo e ammette matematica interna. |
| TX-04 | `\verb`, `\verb*`; `verbatim`, `verbatim*`, `Verbatim`, `BVerbatim`, `LVerbatim`, `lstlisting`, `minted`, `comment`, `filecontents`, `filecontents*` | Corpo opaco alla sintassi TeX, con confine di chiusura specifico del costrutto; niente sezioni o label fittizie. `minted` conserva riconoscibili gli argomenti dell'apertura. |
| TX-05 | `part` fino a `subparagraph`, stelle, titolo breve, titoli multilinea e gruppi annidati | Indice completo e gerarchico; titolo lungo leggibile; voce non numerata per la forma stellata. La numerazione è editoriale, non replica contatori TeX. |
| TX-06 | Ambienti standard e nomi personalizzati letterali | Pairing per nome, annidamento e chiusure discordanti; distinguere il gruppo `{…}` dall'ambiente `\begin…\end`. |
| TX-07 | `newcommand`, `renewcommand`, `providecommand`, `DeclareRobustCommand`, varianti xparse `New/Renew/ProvideDocumentCommand`; `def/gdef/edef/xdef`; ambienti definiti con forme classiche e xparse | Registrare nomi letterali e intervalli di definizione, senza espandere i corpi. Conservare i suggerimenti già disponibili. |
| TX-08 | `label`, famiglia ref/cite già supportata, `input`, `include`, `includegraphics`, `bibliography`, `addbibresource` | Riconoscere il ruolo degli argomenti tramite catalogo di firme, comprese liste e opzioni. Niente regex generica «qualsiasi comando che contiene cite». |
| TX-09 | `\makeatletter`/`\makeatother`, file `.sty/.cls`, `\ExplSyntaxOn`/`\ExplSyntaxOff` | Profilo lessicale esplicito per `@`, `_` e `:`; test del cambio profilo e dell'invalidazione incrementale. |

Le estensioni di catcode arbitrarie, espansione di macro, nomi costruiti con
`\csname`, condizioni eseguite dal motore e linguaggi dentro `minted` restano
supporto conservativo. I comandi sconosciuti hanno il colore dei comandi e non
producono un errore soltanto perché assenti dal catalogo. Nei corpi delle
definizioni non creare sezioni o riferimenti di documento come se il codice fosse
già stato eseguito. I rami condizionali non valutati restano sintassi visibile,
senza pretendere di conoscere il ramo attivo.

### 5.2 LilyPond

| ID | Copertura richiesta | Aspettativa verificabile |
| --- | --- | --- |
| LY-01 | Commenti `%`, `%{…%}`, stringhe, escape, input incompleto | Nessun comando, blocco o nota riconosciuto nel contenuto opaco. Le regole dei commenti seguono la versione di riferimento. |
| LY-02 | Altezze, alterazioni, ottave, `!`/`?`, pause `r/R/s`, ripetizione accordo `q`, durate puntate, durate simboliche e moltiplicatori | In `cis'8.*3/2` separare altezza/ottava, durata e fattore; `r` in musica è una pausa, in testo è testo. Riconoscere durate ripetute senza nuova nota. |
| LY-03 | `{…}`, `<<…>>`, accordi `<…>`, voci `\\`, barre, legature, travature, articolazioni, dinamiche, forcelle `\<`, `\>`, `\!` | Distinguere accordo e simultaneità; `\<` è un evento espressivo, non un'apertura strutturale. |
| LY-04 | `book`, `bookpart`, `score`, `header`, `paper`, `layout`, `midi`, assegnazioni, `new/context`, `with` | Indice e regioni includono il corpo corretto anche dopo un lungo blocco `\with`; nessun limite arbitrario di 240 caratteri. |
| LY-05 | `relative`, `absolute`, `fixed`, `transpose`, `repeat`, `alternative`, `tuplet`, `grace`; modi note, lyrics, chords, drums, figures, markup | Il contesto determina la categoria: `c` in markup/lyrics non è una nota. In `\figuremode { <6>4 }`, `6` è cifra di basso, `4` durata. |
| LY-06 | `\language` e convenzioni dei nomi delle note | Prima qualifica: `nederlands` predefinito, `italiano`, `english`, `deutsch`, inclusi alias documentati, alterazioni e quarti di tono previsti da quei cataloghi. |
| LY-07 | `override`, `revert`, `set`, `unset`, `tweak`, nomi di contesto, grob e proprietà composte | In `\override NoteHead.color = #red`, distinguere comando, proprietà e valore Scheme; un grob sconosciuto non diventa un errore. |
| LY-08 | Espressioni Scheme introdotte da `#`, `$`, `#@`, `$@`; liste, quote, booleani, numeri, stringhe, commenti e `#{…#}` | I confini di Scheme e LilyPond restano corretti; `%` in Scheme non apre un commento LilyPond. La musica dentro `#{…#}` torna alle categorie musicali. |

Nel riconoscimento dei nomi usare i cataloghi versionati, evitando regex come
`[a-g]+` su qualunque parola. Le quattro convenzioni iniziali coprono il default
LilyPond e casi d'uso da qualificare con l'utente; aggiungere le altre convenzioni
tramite dati e fixture senza cambiare il contratto.

**Include e contesto:** il primo traguardo analizza il file corrente e registra
gli include letterali. Un `.ily` privo di `\language` usa `nederlands` come
ipotesi editoriale dichiarata; non dichiarare di conoscere una lingua ereditata
dal chiamante. Una lingua sconosciuta o un include che può cambiare le convenzioni
rende incerta la classificazione delle altezze successive, fino a una direttiva
locale esplicita. Mantenerne neutri i nomi ambigui, preservando durate e struttura.
Un resolver futuro potrà fornire il contesto iniziale e la sua provenienza,
senza confondere la lingua EN/IT dell'interfaccia con i nomi delle note.

Per Scheme realizzare un lettore sintattico del sottoinsieme dichiarato, senza
valutazione: delimitazione di datum, quote/quasiquote/unquote, vettori, caratteri
come `#\)`, commenti `;`, `#|…|#`, `#;` e `#!…!#` con regole Guile applicabili.
Le estensioni reader non riconosciute rendono il tratto incerto e impediscono
azioni strutturali su quel tratto. Non basta contare le parentesi senza gestire
stringhe, commenti e caratteri.

## 6. Architettura proposta

```text
Documento CodeMirror + transazioni locali/remote
                    |
       LRLanguage LaTeX / LilyPond
       grammatica + tokenizer contestuali
                    |
        albero sintattico incrementale
          |                  |
       styleTags       servizio linguaggio
          |           /      |        \
    ruoli e CSS    contesto  sintesi   piani di editing
                      |       |        |
                 completion  indice/   Enter e protezione
                 e pairing   regioni   del testo letterale
```

### 6.1 Moduli e dipendenze

- `public/languages/latex/` e `public/languages/lilypond/`: grammatica,
  tokenizer esterni, catalogo di costrutti e query sull'albero, separati per
  responsabilità. Usare `.mjs` per renderli importabili dal browser e dai test
  Node nel progetto CommonJS.
- `public/iris-language-service.mjs`: contratti comuni, sintesi e contesti.
  `public/iris-syntax-style.mjs`: tag/classi; i valori cromatici restano nel CSS.
- `public/iris-editor.js`: integrazione di linguaggio e ciclo di vita, senza
  inserire grammatiche nel già ampio adapter.
- `public/iris-completion.js`: preservare il normalizzatore usato dal server;
  passare il servizio browser per l'analisi sintattica. Il server non deve
  importare CodeMirror o nuovi parser attraverso questo modulo condiviso.
- `public/iris-structure.js`: consumare regioni già calcolate. L'app legge una
  sintesi comune per indice e presenza, anziché richiamare due parser di stringhe.

`@lezer/common` 1.5.2, `@lezer/highlight` 1.2.3 e `@lezer/lr` 1.4.10 sono già
presenti nel lockfile come dipendenze transitive. Dichiararli diretti quando i
nuovi moduli li importano. Aggiungere `@lezer/generator` 1.8.0 come dipendenza di
sviluppo, con versioni esatte e verifica sul lockfile al momento dell'esecuzione.
Lezer dichiara licenza MIT; aggiornare `THIRD_PARTY_NOTICES.md` per le dipendenze
e registrare la provenienza di eventuali cataloghi derivati.

Generare e conservare i parser `.mjs` insieme alle grammatiche `.grammar`.
L'installazione di produzione deve avviarsi con i file generati già presenti.
Aggiungere `@lezer/lr` all'import map e alla whitelist vendor in `src/server.js`.
Lo script di release attuale esclude `.grammar`: estenderne il filtro e i test,
così l'archivio sorgente contiene ciò che serve per rigenerare i parser.

### 6.2 Regole per riuso e recupero

Usare `LRLanguage`, `styleTags`, tokenizer esterni e `ContextTracker` dove
necessario. Il contesto deve essere immutabile e il suo hash deve rappresentare
le informazioni che condizionano il riuso: modalità, ambiente letterale,
delimitatore matematico, profilo TeX e lingua delle note.

Non dedurre gli ambienti LaTeX soltanto da parentesi bilanciate: i nomi di
`begin`/`end` possono essere arbitrari. Tenere uno stack di contesto per abbinare
i nomi e verificare il recupero su chiusure discordanti. In LilyPond la stessa
grammatica editoriale può rappresentare le isole Scheme e la musica annidata;
un parser Scheme montato con `parseMixed` resta una possibilità se la prova
tecnica ne dimostra la convenienza. Il piano iniziale usa un unico albero per
evitare due gestioni dei confini.

Una chiusura mancante può estendere un contesto fino a fine documento: non
inventare una fine a ogni riga per nascondere l'incompletezza. `\verb` termina
invece al delimitatore o al confine di riga previsto dal costrutto. Su chiusure
discordanti recuperare al delimitatore compatibile; contrassegnare i nodi
recuperati. La correzione del testo deve ristabilire lo stesso albero ottenuto
con un parsing da zero.

### 6.3 Dati condivisi e revisione

Il piano specifica le firme eseguibili. Il contratto include:

- Intervalli **UTF-16 `[from, to)`**, riferiti al documento CodeMirror effettivo.
  Nessuna normalizzazione del testo durante l'analisi. I test coprono Unicode,
  CRLF e modifiche remote.
- Sintesi con `{kind, revision, generation, status, parsedTo, outline, regions,
  symbols, references, includes}`. `status` vale `ready`, `partial` o
  `unavailable`; copertura del parser e completezza sintattica sono concetti
  distinti. Un documento interamente analizzato può contenere nodi incompleti.
- Nodi estratti con `certainty: exact | recovered | unknown` e intervalli di
  definizione/riferimento, senza promettere risoluzione semantica cross-file.
- Contesto al cursore con modalità, intervallo, ruolo dell'argomento e certezza.
  La stessa risposta guida completamento, pairing e decisione su Enter.
- A fine file il cursore può appartenere a una regione aperta; tra due regioni
  adiacenti la posizione iniziale della seconda appartiene alla seconda. Rendere
  esplicita questa convenzione anche in `IrisStructure.pathAt()`.

Il servizio usa l'albero già mantenuto da CodeMirror. Una richiesta nel percorso
di digitazione può avanzare il parser con un budget di **5 ms**; se il contesto
resta incerto, evita suggerimenti automatici e chiusure aggiunte. L'inserimento
dell'utente prosegue. Il movimento del cursore non provoca una scansione completa.

Per le sintesi usare il debounce attuale di **250 ms** e lavorare in tranche da
**8 ms**. Aggiornare quando cambia il documento o avanza il suo albero, anche
senza `docChanged`. Scartare risultati di revisioni o generazioni superate dopo
cambio file, cambio progetto, resync o chiusura. Mappare le vecchie posizioni con
`ChangeDesc` prima di riutilizzarle; sospendere gli avvisi di contenenza se la
regione interessata non è più affidabile. Non trattare un albero parziale come
una nuova sintesi completa che cancella le voci fuori viewport.

Per i file di progetto non aperti riusare le sintesi per identità e contenuto;
analizzare solo gli elementi cambiati, in tranche a bassa priorità. Conservare
le sintesi, non un albero completo per ogni file. La completion può usare la
cache valida e aggiornare i suggerimenti dopo l'analisi. Rimuovere le voci dei
file cancellati e le cache del progetto precedente.

## 7. Integrazione delle funzioni esistenti

**Indice e presenza.** Derivare entrambi dalla stessa sintesi. L'indice LaTeX
mostra i sette livelli; la UI può contenere il rientro visivo senza perdere il
livello semantico. Nell'indice LilyPond mantenere variabili, contesti e blocchi;
mostrare il titolo di score/header quando è una stringa letterale. Le regioni
mantengono etichette comprensibili e i confini di contenimento già richiesti
dai test collaborativi.

**Completamento.** Conservare comandi personalizzati e suggerimenti dai file di
progetto; usare contesti e firme del catalogo per decidere quando proporli.
Commenti, literal e stringhe ordinarie non aprono suggerimenti di comandi. Le
stringhe-path possono avere un ruolo distinto senza introdurre ora un nuovo
completamento dei percorsi. Le note non devono comparire come comandi. I nomi
dinamici restano sconosciuti e non generano falsi errori.

**Enter e pairing.** Riusare le transazioni granulari, il multi-cursore, i marker
delle parentesi inserite e i controlli read-only/IME. Il servizio propone un piano
solo per aperture riconosciute e nel contesto attuale. Mantenere la prenotazione
delle chiusure dell'ambiente esterno, anche con nomi uguali. Con più cursori usare
stati temporanei aggiornati da destra a sinistra, così i piani successivi vedono
le chiusure già aggiunte. Trattare `#{…#}` come una coppia propria, non come `{}`.

**Formattazione.** Limitare l'intervento all'indentazione strutturale e alla
protezione del contenuto letterale, delle stringhe multilinea e delle isole
Scheme non qualificate. Applicare cambiamenti granulari: nessuna riscrittura di
note, macro, spazi significativi o righe interne ai literal. La formattazione
deve essere idempotente e annullabile in un'unica operazione.

**Diagnostiche e folding.** Il parser espone incompletezza e incertezza ai
consumatori. Il primo traguardo non trasforma ogni nodo di recupero Lezer in una
segnalazione rossa: il gutter attuale rappresenta diagnostiche del compilatore
con una revisione di build. Nuove diagnostiche locali, folding e selezione
strutturale sono estensioni successive, con specifiche dedicate; questa base
fornisce nodi e intervalli per realizzarle.

## 8. Qualità, prestazioni e verifica con l'utente

### Obiettivi misurabili proposti

| Misura | Obiettivo iniziale |
| --- | --- |
| Digitazione su file da 100 KiB / circa 2.000 righe | p95 da input a highlighting visibile ≤ 50 ms |
| Digitazione su file da 1 MiB / circa 20.000 righe | p95 ≤ 100 ms |
| Prima evidenziazione del viewport su 1 MiB | ≤ 200 ms, distinta dal caricamento rete |
| Sintesi dopo pausa, file da 1 MiB | disponibile entro 500 ms, inclusi i 250 ms di debounce |
| Lavoro sincrono introdotto nel percorso di digitazione | budget parser 5 ms; nessun long task > 50 ms attribuibile alla funzione |
| File da 5 MiB o singola riga da 100 KiB | editing utilizzabile, analisi differita e stato parziale esplicito; nessun crash |
| Cambio file ripetuto | cache a crescita limitata: conservare sintesi, eliminare gli alberi dei documenti chiusi |

Sono obiettivi da validare con HP-01/HP-03, non misure già ottenute. Registrare
CPU, RAM, OS, versione del browser, dimensioni e numero di righe, cold/warm run,
20 esecuzioni dopo 5 di riscaldamento. Misurare separatamente inserimento locale,
modifica remota e apertura/chiusura di un commento in testa al file: quest'ultimo
caso può richiedere rianalisi estesa anche con un parser incrementale.

### Corpus e prova d'uso

Preparare fixture sintetiche annotate e raccogliere con l'utente 3 sorgenti
LaTeX e 3 LilyPond rappresentativi: documento matematico, documento con macro e
verbatim, progetto con include; partitura con voci, testo cantato, personalizzazioni
Scheme. Anonimizzare gli esempi destinati al repository e registrarne la licenza.

Ogni fixture definisce ruoli e intervalli attesi, voci dell'indice e contesti
al cursore. Aggiungere input troncati, errori di delimitazione e riparazioni.
Confrontare parsing incrementale e parsing completo dopo ogni modifica della
sequenza. Usare il compilatore su un sottoinsieme valido per verificare che le
fixture rappresentino sintassi reale; il compilatore non è l'oracolo dei colori.

Due sessioni di riscontro, da circa 30 minuti: dopo la palette e dopo la
migrazione. L'utente deve poter individuare comandi, commenti, note/durate,
verbatim e confini dei blocchi nei propri esempi, segnalando i casi ambigui.
Registrare gli esiti per caso, oltre alla preferenza estetica.

## 9. Consegne, rischi e decisioni

Il piano divide il lavoro in otto attività HP-01…HP-08, con file, contratti,
test e dipendenze. Su indicazione dell'utente, lo sviluppo è fortemente
agentico e il piano segue i risultati verificati, senza stime temporali.
Il primo miglioramento visivo comprende HP-01 e HP-02. Ogni punto completato
riceve un commit su `main`, dopo sviluppo in worktree e revisione.

| Rischio concreto | Trattamento previsto |
| --- | --- |
| TeX dinamico e funzioni Scheme modificano l'interpretazione | Profili e sottoinsieme dichiarati; categoria generica e certezza `unknown` quando serve. |
| Un cambio di contesto invalida il riuso incrementale | Context hash, sequenze di edit e confronto con parsing da zero. |
| Tre funzioni continuano a usare scanner diversi | Migrazione per linguaggio; rimozione dei vecchi percorsi dopo la parità dei consumatori. |
| Una palette misurata risulta faticosa nei sorgenti lunghi | Verifica con l'utente su file reali, entrambe le modalità e selezioni sovrapposte. |
| L'analisi penalizza la digitazione o mostra dati obsoleti | Budget, tranche, cache per revisione/generazione, test con risposte ritardate. |
| L'archivio contiene solo i parser generati | Test di packaging per `.grammar`, `.mjs`, cataloghi e rigenerazione deterministica. |

**Decisioni da confermare prima dell'esecuzione:** adozione di Lezer dopo prova
tecnica; primo corpus dell'utente e convenzioni LilyPond prevalenti; priorità
relativa dei due linguaggi se si desidera consegnarne uno prima; accettazione
visiva della palette. La proposta assume pari priorità funzionale, quattro
convenzioni delle note nella prima qualifica e parser locali nel browser.

## 10. Riferimenti

- [Valutazione di temi, colori e comandi personalizzati dopo HP-08](../docs/highlighting-customization.md).

- [Contratto colori di Iris](../docs/ui-colors.md), [guida utente](../docs/user-guide.md), [sviluppo e gate](../docs/development.md).
- [Roadmap R11](NEXT_STEPS.md) e [registro di avanzamento](backend-implementation-status.md).
- [CodeMirror: language package](https://codemirror.net/examples/lang-package/).
- [Lezer: guida, recupero, contesti e parsing incrementale](https://lezer.codemirror.net/docs/guide/).
- [LilyPond 2.26: nomi delle note](https://lilypond.org/doc/v2.26/Documentation/notation/writing-pitches#note-names-in-other-languages).
- [LilyPond 2.26: confini Scheme](https://lilypond.org/doc/v2.26/Documentation/extending/lilypond-scheme-syntax).
- Metadati npm consultati il 15 settembre 2026: [`@lezer/lr` 1.4.10](https://registry.npmjs.org/@lezer%2Flr/1.4.10), [`@lezer/generator` 1.8.0](https://registry.npmjs.org/@lezer%2Fgenerator/1.8.0).
