# Lataaja – älykäs latausikkunan optimointi

Lataaja on selainpohjainen työkalu, joka auttaa mitoittamaan sähköauton latausikkunan
Suomen pörssisähkön, siirtomaksujen ja tehomaksujen perusteella. Sovellus hakee
spot-hinnat julkisesta [api.spot-hinta.fi](https://api.spot-hinta.fi) -rajapinnasta ja
laskee kustannuksiltaan edullisimman latausjakson annettujen teho- ja energiasäätöjen
perusteella.

## Miten sovellus toimii

1. **Hintadata** – Sovellus hakee uusimmat spot-hinnat rajapinnasta ilman
   varahinnoittelua. Jos haku epäonnistuu, käyttöliittymä ilmoittaa virheestä eikä näytä
   vanhentuneita arvioita.
2. **Siirtomaksu** – Laskenta huomioi siirtomaksun €/kWh. Hinta määräytyy kellonajan ja
   konfiguraatiotiedostossa määriteltyjen aikavälien perusteella. Uusia hintatasoja voi
   lisätä helposti lisäämällä uusia tasoja konfiguraatioon.
3. **Tehomaksu** – Laskenta ottaa haluttaessa huomioon tehomaksun €/kW. Tehomaksu
   määräytyy sen tunnin perusteella, jolloin keskimääräinen teho on suurin valitulla
   latausjaksolla. Tehomaksun voi myös ohittaa käyttöliittymän asetuksesta.
4. **Optimointi** – Sovellus käy läpi vaihtoehtoiset latausikkunat, kunnes löytää
   kustannuksiltaan edullisimman yhdistelmän spot-hintojen, sähkön marginaalin,
   siirtomaksujen ja tehomaksun summana.

## Hinnoittelukokonaisuudet

Sovellus tukee useita verkkoyhtiöitä ja jokainen hinnasto säilytetään omassa tiedostossaan
hakemistossa [`config/pricing/`](config/pricing/). Manifesti
[`config/pricing/manifest.json`](config/pricing/manifest.json) määrittelee, mitkä
hinnoittelut näkyvät käyttöliittymän valitsimessa sekä mikä niistä on oletus
(`Helen-sähköverkko`). Manifestin rakenne on seuraavanlainen:

```json
{
  "default": "helen",
  "pricings": [
    {
      "id": "helen",
      "name": "Helen-sähköverkko",
      "configPath": "helen.json"
    },
    {
      "id": "vantaan-energia",
      "name": "Vantaan Energia Sähköverkot",
      "configPath": "vantaan.json"
    },
    {
      "id": "caruna-espoo",
      "name": "Caruna Espoo",
      "configPath": "caruna.json"
    }
  ]
}
```

Jokainen `configPath` osoittaa yksittäiseen hinnastoon. Hinnastot käyttävät samaa rakennetta
kuin aiemmin, eli niissä on `siirto`- ja `teho`-osiot, joiden `tiers`-taulukko määrittelee
hinnaston voimassaoloajat, viikonpäivät sekä kellonaikavälit. Esimerkki löytyy tiedostosta
[`config/pricing/helen.json`](config/pricing/helen.json). Kun lisäät uuden hinnoittelun,
luo sitä vastaava JSON-tiedosto `config/pricing/`-hakemistoon ja lisää se manifestiin
ID:n, julkisen nimen ja tiedostopolun kanssa.

Jos hinnastosta puuttuu vaadittuja kenttiä tai ne ovat virheellisiä, sovellus ilmoittaa
virheestä eikä käytä puutteellista konfiguraatiota.

## Käyttöliittymän työkalut

Käyttöliittymän yläosassa on nyt hinnoittelun valitsin ja toimintopainikkeet:

- **Hinnoittelun valitsin** – voit vaihtaa verkkoyhtiötä. URL-polku päivittyy valinnan
  mukaan (esim. `/helen`, `/vantaan-energia`), joten oikean hinnoittelun voi jakaa myös
  linkin kautta. Sivulle palattaessa polun perusteella valitaan automaattisesti oikea
  hinnasto.
- **Päivitä hinnat** – hakee spot-hinnat ja valitun hinnoittelun siirto- ja tehotiedot
  uudelleen.
- **Tallenna asetukset** – tallentaa lataustehon, energiamäärän, tehomaksuvalinnan,
  täyden akun asetuksen, sähkön marginaalin ja valitun hinnoittelun selaimen `localStorageen`. Asetukset
  ladataan automaattisesti, kun sivu avataan seuraavan kerran.
- **Jaa linkki** – kopioi nykyisen sivun osoitteen (polku mukaan lukien) leikepöydälle, jotta
  asetukset ja hinnoittelu on helppo jakaa.

Latausasetusten liukusäätimillä voi määrittää ladattavan energian, lataustehon sekä
sähkön marginaalin. Marginaali lisää valitun lisän spot-hinnan päälle (säätöalue
0,01–1,20 €/kWh) ja vaikuttaa kaikkiin energiahintaan perustuviin laskelmiin.

Latausnäkymässä poistettiin vanha teksti “Lataus (15 min)” ja sen sijaan esitetään selkeästi
lataukseen kuluva aika muodossa `Latausaika ...`.

## Käyttöönotto ja testaus

Sovellus on staattinen ja toimii suoraan selaimessa. Paikallista testausta varten riittää
avata `index.html` modernissa selaimessa. Hintarajapinnan toimivuuden voi tarkistaa
esimerkiksi komennolla:

```bash
curl -I https://api.spot-hinta.fi/Today
```

Jos rajapinta ei ole saatavilla tai vastaa virheeseen, sovellus ilmoittaa käyttäjälle
hintadatan puuttumisesta eikä näytä vanhoja fallback-hintoja.
