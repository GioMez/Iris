# WebTeX

Frontend statico + backend minimale per login e gestione progetti.

## Struttura

```text
public/   frontend servito al browser
src/      backend Node
db/       schema SQL e, in futuro, migration
data/     dati progetto locali, ignorati da git
```

## Avvio sviluppo

1. Installa le dipendenze:

```sh
npm install
```

2. Avvia MariaDB, ad esempio con Docker:

```sh
docker compose up -d mariadb
```

Oppure, con un MariaDB gia' installato:

```sql
CREATE DATABASE IF NOT EXISTS webtex CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'webtex'@'localhost' IDENTIFIED BY 'webtex';
GRANT ALL PRIVILEGES ON webtex.* TO 'webtex'@'localhost';
FLUSH PRIVILEGES;
```

3. Copia la configurazione e cambia il secret:

```sh
cp .env.example .env
```

4. Avvia il backend:

```sh
npm start
```

Apri `http://localhost:3000`.

## Avvio con Docker Compose

Per avviare webapp e database insieme:

```sh
docker compose up --build
```

La webapp espone `http://localhost:3000`. I dati MariaDB e i progetti sono salvati in volumi Docker.

Nel profilo Docker Compose il percorso dei binari LaTeX e' configurato via ambiente:

```yaml
TEX_BIN_PATH: /usr/local/texlive/bin/x86_64-linux
TEX_PATH_LOCKED: "true"
```

Quando `TEX_PATH_LOCKED` e' `true`, il campo nei settings resta visibile ma non modificabile: il valore va cambiato nel file `docker-compose.yml` o nella configurazione del container.

## Compilazione LaTeX

Il pulsante `Compila` salva il progetto, lancia il motore selezionato lato backend e mostra il PDF prodotto nel pannello di anteprima. Il log reale del processo viene riportato nel tab `Log`, mentre la barra in basso mostra durata, warning/errori e dimensione del PDF.

Variabili utili:

```env
TEX_BIN_PATH=/usr/local/texlive/bin/x86_64-linux
COMPILE_TIMEOUT_MS=30000
COMPILE_LOG_LIMIT=1048576
```

Prime protezioni attive:

- LaTeX viene lanciato senza shell e con `-no-shell-escape`.
- Per XeLaTeX/LuaLaTeX WebTeX espone la cartella `fonts/` del progetto via `OSFONTDIR`, usa una cache TeX per-progetto in `.webtex/texmf-var` e prova ad aggiornare `fc-cache` prima della compilazione, se disponibile.
- L'ambiente del processo di compilazione non eredita le credenziali del backend.
- Il container webapp gira come utente non-root.
- Le immagini Docker sono pinnate a tag specifici (`node:22.22.2-alpine3.22`, `mariadb:11.4.10-noble`) invece di tag floating.
- Nel Compose la webapp usa `read_only`, `tmpfs` su `/tmp`, `cap_drop: ALL` e `no-new-privileges`.

Nota: la compilazione LaTeX resta una superficie sensibile. Il passo successivo consigliato e' isolare la compilazione in un worker/container dedicato, senza accesso a codice applicativo, variabili DB o volume completo dei progetti.

## Account iniziali

Alla prima partenza, se la tabella utenti e' vuota, il backend crea:

- `rossi` / `webtex`
- `demo` / `demo`

## Persistenza

- MariaDB contiene utenti e metadati dei progetti.
- Ogni progetto ha una cartella sotto `DATA_DIR`.
- I file del progetto vengono salvati come file reali, ad esempio `main.tex`, `references.bib`, `figure/plot.png`.
- I font caricati dalle impostazioni vengono salvati come file reali sotto `fonts/`.
- Lo stato dell'editor e l'albero dei file vengono salvati in `.webtex/project.json`, senza duplicare il contenuto dei file sorgente.
