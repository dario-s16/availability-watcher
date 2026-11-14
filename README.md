# Libraccio Availability Watcher

## English

A free Telegram bot that monitors used-book availability on Libraccio and shows current new and used prices.

Try it here: [@MonitorUsatoLibraccioBot](https://t.me/MonitorUsatoLibraccioBot)

> The bot depends on Libraccio's current website structure and may require updates if the site changes.

### Features

- Search by title, optionally followed by the author, ISBN or Libraccio link
- Choose between different editions
- Periodic used-book availability checks
- New and used price information
- Telegram notifications when a used copy becomes available
- Automatic SQLite database backups

## Italiano

Bot Telegram gratuito che monitora la disponibilità dei libri usati su Libraccio e mostra i prezzi correnti del nuovo e dell'usato.

Puoi provarlo qui: [@MonitorUsatoLibraccioBot](https://t.me/MonitorUsatoLibraccioBot)

> Il funzionamento dipende dalla struttura attuale del sito Libraccio e potrebbe richiedere aggiornamenti se il sito cambia.

### Funzionalità

- Ricerca tramite titolo, eventualmente seguito dall'autore, ISBN o link Libraccio
- Scelta tra diverse edizioni
- Controllo periodico della disponibilità dell'usato
- Visualizzazione dei prezzi del nuovo e dell'usato
- Notifica Telegram quando una copia usata diventa disponibile
- Backup automatici del database SQLite

## Local setup

Requires Node.js 24.22.3 or a newer Node.js 24 release.

```bash
npm install
cp .env.example .env
npm run build
npm start
```

Add the Telegram bot token to `.env`. The Google Books API key is optional.

The optional `TELEGRAM_ADMIN_CHAT_ID` enables the private `/stats` command for the configured chat.

Run the project checks and tests with:

```bash
npm run check
npm test
```

## Privacy

The database stores Telegram chat identifiers and the books monitored by each user.

Users can delete their account and watchlist with `/deleteaccount`. Deleted data may remain in automatic backups until those backups are replaced.

## Disclaimer

This is an independent project and is not affiliated with Libraccio.

## License

MIT
