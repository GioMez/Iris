# Iris

Frontend statico + backend minimale per login e gestione progetti.

## Struttura

```text
public/   frontend servito al browser
src/      backend Node
db/       schema SQL e, in futuro, migration
data/     dati progetto locali, ignorati da git
```

## Avvio sviluppo

1. Installa Node.js 24 LTS, quindi le dipendenze:

```sh
npm install
```

2. Avvia MariaDB, ad esempio con Docker:

```sh
docker compose up -d mariadb
```

Oppure, con un MariaDB gia' installato:

```sql
CREATE DATABASE IF NOT EXISTS iris CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'iris'@'localhost' IDENTIFIED BY 'iris';
GRANT ALL PRIVILEGES ON iris.* TO 'iris'@'localhost';
FLUSH PRIVILEGES;
```

3. Copia la configurazione e genera un secret di sessione:

```sh
cp .env.example .env
openssl rand -hex 32
```

Incolla il valore generato in `IRIS_SECRET` dentro `.env`. Il backend rifiuta
di avviarsi se il secret manca o usa uno dei valori predefiniti noti.

4. Avvia il backend:

```sh
npm start
```

Apri `http://localhost:3000`.

## Avvio con Docker Compose

Per avviare webapp e database insieme:

```sh
export IRIS_SECRET="$(openssl rand -hex 32)"
docker compose up --build
```

La webapp espone `http://localhost:3000`. I dati MariaDB e i progetti sono salvati in volumi Docker.

Nel profilo Docker Compose il percorso dei binari LaTeX e' configurato via ambiente:

```yaml
TEX_BIN_PATH: /usr/local/texlive/bin/x86_64-linux
TEX_PATH_LOCKED: "true"
```

Quando `TEX_PATH_LOCKED` e' `true`, il campo nei settings resta visibile ma non modificabile: il valore va cambiato nel file `docker-compose.yml` o nella configurazione del container.

Per LilyPond sono disponibili le variabili equivalenti `LILYPOND_BIN_PATH` e `LILYPOND_PATH_LOCKED`. L'immagine applicativa non include le distribuzioni di compilazione: i binari compatibili vanno montati nel container oppure forniti in un'immagine derivata.

## SSO OAuth 2.0 / OIDC

Iris supporta un login SSO generico OAuth 2.0/OIDC, pensato per Authentik ma non legato a pulsanti provider-specifici. Se `OAUTH_ISSUER_URL` e' impostato, il backend usa la discovery `/.well-known/openid-configuration`.

Variabili principali:

```env
APP_BASE_URL=http://localhost:3000
OAUTH_ISSUER_URL=https://auth.example.org/application/o/iris
OAUTH_CLIENT_ID=iris
OAUTH_CLIENT_SECRET=change-this-client-secret
OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/sso/callback
OAUTH_SCOPE=openid email profile
OAUTH_CLIENT_AUTH_METHOD=client_secret_basic
OAUTH_AUTO_REGISTER=false
```

In alternativa alla discovery via issuer puoi impostare direttamente `OAUTH_AUTHORIZATION_URL`, `OAUTH_TOKEN_URL` e `OAUTH_USERINFO_URL`.

Registra in Authentik la callback `APP_BASE_URL/api/auth/sso/callback`, oppure imposta `OAUTH_REDIRECT_URI` esplicitamente se l'app e' dietro reverse proxy.

L'utente OAuth viene collegato alla tabella interna tramite email. Se l'email non esiste, Iris crea automaticamente un utente con ruolo `user` solo quando `OAUTH_AUTO_REGISTER=true`; altrimenti l'accesso viene rifiutato e l'utente va creato prima nella tabella interna.

Gli utenti creati via SSO hanno `password_hash=NULL`: non possono accedere dal form user/password finche' non viene impostata una password locale. Gli utenti esistenti mantengono il proprio ruolo.

## Compilazione LaTeX

Il pulsante `Compila` salva il progetto, lancia il motore selezionato lato backend e mostra il PDF prodotto nel pannello di anteprima. Il viewer PDF.js locale offre scorrimento continuo, zoom, adattamento alla larghezza e navigazione tra le pagine. Il log reale del processo viene riportato nel tab `Log`, mentre la barra in basso mostra durata, warning/errori e dimensione del PDF.

Gli artefatti di compilazione vengono scritti nella cartella `output/` del progetto e possono essere sovrascritti a ogni compilazione. La pipeline e' configurabile dai settings con preset per compilazione rapida, BibTeX, Biber, indice o step personalizzati. Gli step custom sono strutturati come tool in allowlist piu' argomenti, senza shell libera; sono disponibili le variabili `[engine]`, `[main]`, `[jobname]` e `[pdf]`.

Variabili utili:

```env
TEX_BIN_PATH=/usr/local/texlive/bin/x86_64-linux
COMPILE_TIMEOUT_MS=30000
COMPILE_LOG_LIMIT=1048576
```

Prime protezioni attive:

- LaTeX viene lanciato senza shell e con `-no-shell-escape`.
- Per XeLaTeX/LuaLaTeX Iris espone la cartella `fonts/` del progetto via `OSFONTDIR`, usa una cache TeX per-progetto in `.iris/texmf-var` e prova ad aggiornare `fc-cache` prima della compilazione, se disponibile.
- L'ambiente del processo di compilazione non eredita le credenziali del backend.
- Il container webapp gira come utente non-root.
- Le immagini Docker sono pinnate a tag specifici (`node:24.18.0-alpine3.23`, `mariadb:11.4.10-noble`) invece di tag floating.
- Nel Compose la webapp usa `read_only`, `tmpfs` su `/tmp`, `cap_drop: ALL` e `no-new-privileges`.

Nota: la compilazione LaTeX resta una superficie sensibile. Il passo successivo consigliato e' isolare la compilazione in un worker/container dedicato, senza accesso a codice applicativo, variabili DB o volume completo dei progetti.

## Compilazione LilyPond

Iris gestisce anche progetti musicali testuali LilyPond. In fase di creazione puoi scegliere `Partitura LilyPond`; i progetti esistenti privi di tipo vengono riconosciuti come LilyPond quando contengono file `.ly` e nessun `.tex`.

Per un progetto musicale l'interfaccia usa `main.ly`, mostra solo il compilatore `lilypond` e propone una pipeline coerente. Dalle impostazioni si puo' scegliere il formato di stampa tra PDF, PNG, SVG, PS ed EPS; PNG, SVG e documenti con più blocchi possono generare più artefatti, tutti raccolti nella cartella `output/`. Il viewer mostra PDF, PNG e SVG, mentre PS ed EPS restano scaricabili e visibili nell'albero dei file.

Il campo `Parametri LilyPond` permette inoltre di aggiungere opzioni tra l'eseguibile e il sorgente; i valori tra virgolette vengono mantenuti come un singolo argomento. Il backend invoca LilyPond senza shell e forza formato e destinazione scelti nelle impostazioni, ignorando eventuali override `-o`, `--output`, `-f` o `--format` presenti nei parametri liberi.

Variabili utili:

```env
LILYPOND_BIN_PATH=/usr/bin
LILYPOND_PATH_LOCKED=true
```

Anche i sorgenti LilyPond non fidati devono essere compilati in un worker/container isolato: LilyPond incorpora Guile e la compilazione va considerata esecuzione di input non fidato.

## Password locali

Il login user/password usa Argon2id.

Parametri opzionali:

```env
ARGON2_MEMORY_COST=65536
ARGON2_TIME_COST=3
ARGON2_PARALLELISM=1
```

`ARGON2_MEMORY_COST` e' espresso in KiB. Questi parametri riguardano solo il login locale; gli utenti creati via SSO non hanno password locale.

## Account iniziali

Alla prima partenza, se la tabella `users` e' vuota, il backend crea un solo account locale:

- username `admin`
- ruolo `admin`
- password random generata al momento

La password viene stampata una sola volta nei log dopo l'inizializzazione del backend e non viene salvata in chiaro. Se usi Docker Compose in detached mode, recuperala con:

```sh
docker compose logs webapp | sed -n '/Iris initial admin account created/,+5p'
```

Il seed avviene solo su tabella vuota; non esiste una promotion automatica ricorrente per username o email.

## Persistenza

- MariaDB contiene utenti e metadati dei progetti.
- Ogni progetto ha una cartella sotto `DATA_DIR`.
- I file del progetto vengono salvati come file reali, ad esempio `main.tex`, `references.bib`, `figure/plot.png`.
- I font caricati dalle impostazioni vengono salvati come file reali sotto `fonts/`.
- Lo stato dell'editor e l'albero dei file vengono salvati in `.iris/project.json`, senza duplicare il contenuto dei file sorgente.
