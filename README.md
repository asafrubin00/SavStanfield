# SavStanfield

A personal hub for hip-hop and R&B: one place for releases, artists, producers, ratings, reviews, notes, lists and concerts, with every item linked out to Apple Music, Genius, YouTube, Wikipedia, RYM, AOTY and more.

## What it does

- **Imports the Music tracker spreadsheet**: ALBUMS, UPCOMING, Concerts and Leaks & Compilations, with Def Jam, FRESHMEN and Stanfield Nominations as lists. Re-importing updates what's there instead of duplicating it.
- **Links everything automatically**:
  - Apple Music for links, artwork and tracklists
  - MusicBrainz for IDs plus Wikipedia, Discogs and RYM links
  - Deezer for artist photos and fallback covers
  - Genius for song pages and producer credits
  - YouTube for embeds
  
  It only takes confident matches. Anything uncertain is left for **Match by hand**.
- **Artist and producer pages** with discography by type, production credits, appearances and gigs. **Import discography** pulls an artist's catalogue from Apple Music and MusicBrainz, mixtapes included.
- **Rate, favourite, review and annotate** any artist, release or song. You can also log critic scores, with Pitchfork, AOTY, RYM, Metacritic and Fantano lookups.
- **Search, filter and organise**:
  - Library filters: type, decade, years, rating, producer, favourites, reviewed, upcoming and link status
  - Lists, ranked or unranked, plus charts
  - Global search with the `/` key
- **Add anything by hand** when the sites are missing it or have it wrong. Every link is editable.

## Stack

Vite + React + TypeScript, Supabase (Postgres, magic-link sign-in, row-level security), and one Vercel function (`api/ext.ts`) that proxies the music APIs so keys stay server-side.

Without Supabase configured, the app runs in browser-only mode (IndexedDB). That's handy for trying it out.

## Setup

1. Create a Supabase project. Run `supabase/schema.sql` in its SQL editor.
2. In Supabase → Authentication → URL Configuration, set the Site URL to your deployed URL.
3. Deploy to Vercel and set these environment variables:
   - `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
   - `GENIUS_TOKEN`: free, from genius.com/api-clients
   - `YOUTUBE_KEY`: free YouTube Data API v3 key from Google Cloud
4. Sign in, go to **Import & settings**, upload the spreadsheet, then run **Link artists** and **Link releases**.

## Local dev

```
cp .env.example .env.local   # fill in what you have
npm install
npm run dev
```
