# Availability Watcher

## English

A free Telegram bot that monitors the availability and price of used books on Libraccio.

Try it here: [@MonitorUsatoLibraccioBot](https://t.me/MonitorUsatoLibraccioBot)

### Features

- Search by title, author, ISBN or Libraccio link
- Choose between different editions
- Periodic used-book availability checks
- New and used price information
- Telegram notifications when a used copy becomes available
- Automatic SQLite database backups

## Italiano

Bot Telegram gratuito che monitora la disponibilità e il prezzo dei libri usati su Libraccio.

Puoi provarlo qui: [@MonitorUsatoLibraccioBot](https://t.me/MonitorUsatoLibraccioBot)

### Funzionalità

- Ricerca tramite titolo, autore, ISBN o link Libraccio
- Scelta tra diverse edizioni
- Controllo periodico della disponibilità dell'usato
- Visualizzazione dei prezzi del nuovo e dell'usato
- Notifica Telegram quando una copia usata diventa disponibile
- Backup automatici del database SQLite

## Local setup

Requires Node.js 24.

```bash
npm install
cp .env.example .env
npm run build
npm start
```

Add the Telegram bot token and Google Books API key to `.env`.

Run the project checks with:

```bash
npm run check
npm run build
```

## Privacy

The database stores Telegram chat identifiers and the books monitored by each user.

## Disclaimer

This is an independent project and is not affiliated with Libraccio.

## License

MIT
