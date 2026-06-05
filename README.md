# WebTeX

Frontend statico + backend minimale per login e gestione progetti.

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

## Account iniziali

Alla prima partenza, se la tabella utenti e' vuota, il backend crea:

- `rossi` / `webtex`
- `demo` / `demo`

## Persistenza

- MariaDB contiene utenti e metadati dei progetti.
- Ogni progetto ha una cartella sotto `DATA_DIR`.
- Lo snapshot completo dell'editor viene salvato in `project.json`.
