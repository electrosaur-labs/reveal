# SP100 Dataset

150 images curated for screen printing color separation benchmarking. Fine art, prints, posters, and political art from public domain and open access collections.

## Sources

| Source | Count | License | API/Access |
|--------|-------|---------|------------|
| Metropolitan Museum of Art | 62 | CC0 1.0 | https://metmuseum.github.io/ |
| Rijksmuseum | 50 | CC0 1.0 | https://data.rijksmuseum.nl/ |
| Art Institute of Chicago | 26 | CC0 1.0 | https://api.artic.edu/docs/ |
| Library of Congress | 2 | Public Domain | https://www.loc.gov/free-to-use/ |
| Doug Minkler | 10 | Used with permission | https://www.dminkler.com |

See `LICENSE.md` for full license details per source.

## Acquisition

### Met, Rijksmuseum, AIC, LOC

These are public domain images downloadable via each institution's open access API. Place source JPEGs or TIFFs in the appropriate subdirectory:

```
input/met/jpg/           # or input/met/tiff/8bit/
input/rijks/jpg/         # or input/rijks/tiff/8bit/
input/aic/tiff/8bit/
input/loc/tiff/8bit/
```

### Doug Minkler

10 screen print posters by Doug Minkler (www.dminkler.com). These are included as real-world screen print artwork — the exact use case Reveal targets. Place source JPEGs in `input/minkler/jpg/`.

## Preparation

Convert source images to 16-bit Lab PSDs:

```bash
npm run convert:sp100           # Convert all sources
npm run convert:sp100 met rijks # Convert specific sources
```

The converter searches both `jpg/` and `tiff/8bit/` input directories per source.
Converted PSDs are written to `input/<source>/psd/8bit/`.

## Directory Structure

```
SP100/
  input/
    <source>/
      jpg/              # Source JPEGs (not included)
      tiff/8bit/        # Source TIFFs (not included)
      psd/8bit/         # Converted 8-bit Lab PSDs (generated)
  output/
    psd/8bit/           # Posterized PSDs + JSON sidecars (generated)
  LICENSE.md            # Per-source license details
```

Sources: met (62), rijks (50), aic (26), loc (65), minkler (10)

## Image List

### Metropolitan Museum of Art (62)

Primarily Rembrandt paintings, etchings, and early 20th century poster art.

| File | Subject |
|------|---------|
| met_11742 | The Marquis de Lafayette |
| met_16687 | Michael Angelo and Emma Clara Peale |
| met_333990 | Moulin Rouge, La Goulue |
| met_339108 | The New York Herald, Sunday, August 29th |
| met_354631 | Christ Crucified between the Two Thieves (The Three Crosses) |
| met_391544 | Rembrandt with Raised Sabre |
| met_391614 | The Old Bearded Man in a High Fur Cap, with Eyes Closed |
| met_399781 | The Three Trees (after Rembrandt) |
| met_399782 | The Three Trees (after Rembrandt) |
| met_399783 | The Three Trees (after Rembrandt) |
| met_399786 | The Three Trees (after Rembrandt) |
| met_437385 | Man in a Turban |
| met_437386 | Portrait of a Man, probably a Member of the Van Beresteyn Family |
| met_437387 | Portrait of a Man |
| met_437388 | Portrait of a Woman, probably a Member of the Van Beresteyn Family |
| met_437389 | Bellona |
| met_437390 | Portrait of a Woman |
| met_437391 | Portrait of a Young Woman with a Fan |
| met_437392 | Herman Doomer (ca. 1595-1650) |
| met_437393 | The Toilet of Bathsheba |
| met_437394 | Aristotle with a Bust of Homer |
| met_437395 | The Standard Bearer (probably Floris Soop, 1604-1657) |
| met_437396 | Hendrickje Stoffels (1626-1663) |
| met_437397 | Self Portrait |
| met_437399 | Man with a Magnifying Glass |
| met_437400 | Portrait of a Man |
| met_437402 | Woman with a Pink |
| met_437403 | Christ and the Woman of Samaria |
| met_437404 | Head of Christ |
| met_437406 | Portrait of a Man ("The Auctioneer") |
| met_437407 | Christ with a Staff |
| met_437409 | Portrait of a Woman |
| met_437410 | Portrait of a Man with a Breastplate and Plumed Hat |
| met_437411 | Man with a Steel Gorget |
| met_437412 | Old Woman Cutting Her Nails |
| met_437413 | Man in a Red Cloak |
| met_437414 | Pilate Washing His Hands |
| met_437416 | Man in Armor (Mars) |
| met_437417 | Lieven Willemsz van Coppenol (born about 1599, died 1671 or later) |
| met_437418 | Man with a Beard |
| met_437419 | Rembrandt (1606-1669) as a Young Man |
| met_437420 | Rembrandt's Son Titus (1641-1668) |
| met_437421 | Study Head of an Old Man |
| met_459082 | Portrait of Gerard de Lairesse |
| met_459194 | The Last Supper (after Leonardo da Vinci) |
| met_459210 | Satire on Art Criticism |
| met_459238 | Cottage near the Entrance to a Wood |
| met_459255 | Elsje Christiaens Hanging on a Gibbet |
| met_459317 | Old Man Leaning on a Stick |
| met_459318 | Two Cottages |
| met_692466 | The Inland Printer, June 1901 |
| met_692469 | Advertisement for Philadelphia Sunday Press, February |
| met_692470 | Advertisement for Philadelphia Sunday Press, May |
| met_692471 | Advertisement for Philadelphia Sunday Press, October |
| met_696945 | Advertisement for Philadelphia Sunday Press, April |
| met_696946 | Advertisement for Philadelphia Sunday Press, Easter |
| met_696947 | Advertisement for Philadelphia Sunday Press, May |
| met_728386 | Rembrandt |
| met_732437 | Advertisement for Philadelphia Sunday Press, February |
| met_732445 | Advertisement for Philadelphia Sunday Press, May |
| met_828418 | Landscape (after Rembrandt) |
| met_899898 | The New York Sunday World, November 17th |

### Rijksmuseum (50)

Dutch Golden Age paintings, landscapes, portraits, and maritime scenes.

| File | Subject |
|------|---------|
| rijks_SK-A-183 | Willem III, prins van Oranje |
| rijks_SK-A-201 | Portrait of a Couple and Four Children |
| rijks_SK-A-270 | Mooy Aal en haar aanbidders |
| rijks_SK-A-276 | Een herderin |
| rijks_SK-A-292 | Portret van Constantijn Huygens |
| rijks_SK-A-294 | The Battle of Livorno |
| rijks_SK-A-671 | The Adoration of the Magi |
| rijks_SK-A-956 | Portret van een jongetje, wellicht Lodewijk van Nassau |
| rijks_SK-A-1100 | Een leeuw uit de menagerie van koning Lodewijk Napoleon |
| rijks_SK-A-1252 | Portrait of Jacoba Bontemantel |
| rijks_SK-A-1453 | Portrait of Willem Bilderdijk |
| rijks_SK-A-1485 | De ontmoeting van Jacob en Rachel |
| rijks_SK-A-1856 | De ontmoeting van Granida en Daifilo |
| rijks_SK-A-1935 | Landschap met stenen brug |
| rijks_SK-A-2121 | Portrait of Paulus Joseph Gabriel |
| rijks_SK-A-2567 | The Virgin and Child |
| rijks_SK-A-2568 | Dancing Couple |
| rijks_SK-A-2670 | Pinken in de branding |
| rijks_SK-A-2727 | Portrait of Frederik Houtman (1571-1627) |
| rijks_SK-A-3089 | Katjesspel |
| rijks_SK-A-3118 | Portraits of Sir Thomas Gresham and Anne Fernely |
| rijks_SK-A-3119 | Portraits of Sir Thomas Gresham and Anne Fernely |
| rijks_SK-A-3229 | Distant View of the Meadows at 's-Graveland |
| rijks_SK-A-3230 | De vaart bij 's-Graveland |
| rijks_SK-A-3245 | River View by Moonlight |
| rijks_SK-A-3256 | Winter Landscape near a Town with Bare Trees |
| rijks_SK-A-3331 | Portrait of Willem III, Prince of Orange |
| rijks_SK-A-3843 | Een vrouw |
| rijks_SK-A-3901 | De boom van Jesse |
| rijks_SK-A-4013 | Portrait of Govert van Slingelandt (1623-1690) |
| rijks_SK-A-4223 | Berglandschap bij Dusseldorf |
| rijks_SK-A-4232 | Zelfportret |
| rijks_SK-A-4474 | VOC vestigingen |
| rijks_SK-A-4644 | Schipbreuk op een rotsachtige kust |
| rijks_SK-A-4760 | Portret van Jacob de Witt (1589-1674) |
| rijks_SK-A-4761 | Portrait of Anna van den Corput (1599-1645) |
| rijks_SK-A-4878 | A Young Woman Warming her Hands over a Brazier (Allegory of Winter) |
| rijks_SK-A-5082 | De Aanbidding van de koningen |
| rijks_SK-A-5110 | Self Portrait |
| rijks_SK-C-140 | Woman Playing the Virginal |
| rijks_SK-C-197 | De harddraver De Vlugge van Adriaan van der Hoop |
| rijks_SK-C-198 | Adriaan van der Hoop's Trotter "De Rot" at the Coach House |
| rijks_SK-C-200 | Boerengezelschap binnenshuis |
| rijks_SK-C-528 | Portret van Johannes Hudde |
| rijks_SK-C-1215 | Thomas Hees en zijn bediende |
| rijks_SK-C-1440 | Portret van een man, vermoedelijk uit het geslacht Bentinck |
| rijks_SK-C-1454 | Portret van Lysbeth van Duvenvoirde |
| rijks_SK-C-1535 | The Raampoortje in Amsterdam |
| rijks_SK-C-1586 | Portrait of Aernout van Beeftingh, his Wife Jacoba |
| rijks_SK-C-1726 | Misty Sea |

### Art Institute of Chicago (26)

Mixed collection accessed via AIC API. Files named by AIC object ID (e.g., `aic_131827`).

aic_5519, aic_5520, aic_14572, aic_15468, aic_16568, aic_16622, aic_24645, aic_28560, aic_36504, aic_68433, aic_77333, aic_79763, aic_81558, aic_81558_fullres, aic_87088, aic_88793, aic_131827, aic_135128, aic_137226, aic_140604, aic_149035, aic_158483, aic_188629, aic_204686, aic_243810, aic_259173

### Library of Congress (2)

8b05988u, 8b06077u

### Doug Minkler (10)

Political screen print posters. www.dminkler.com

art_burn_keep, biko, ethnic_cleansing, guantanamo_bay, justice_trumps2, little_money, mayakovski, police_crimes, self_censorship, to_those_who
