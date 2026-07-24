#!/bin/sh
set -eu

: "${DB_PASSWORD:?DB_PASSWORD must be set}"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=iris_password="$DB_PASSWORD" <<-'EOSQL'
	CREATE ROLE iris WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD :'iris_password';
	CREATE DATABASE iris OWNER iris;
EOSQL
