# EV Energy Optimizer

EV Energy Optimizer is a browser-based tool for selecting the most cost-effective
charging window for an electric vehicle in the Finnish electricity market. The
app downloads spot prices from the public
[api.spot-hinta.fi](https://api.spot-hinta.fi) API and combines them with
distribution and peak power fees to recommend the cheapest charging period for a
given amount of energy.

> **Project status**
>
> This app was created primarily with OpenAI’s Codex and has not yet been
> carefully tested. Treat it as an experimental prototype and validate results
> before using them operationally. Feel free to keep developing and extending
> the project as you see fit.

## How it works

1. **Spot price data** – The UI fetches the latest spot prices without using any
   fallback values. If the API request fails, the user is notified and no stale
   data is shown.
2. **Distribution fees** – The computation applies the distribution fee (€/kWh)
   based on the time of day defined in the pricing configuration. Additional fee
   tiers can be added by editing the configuration files.
3. **Peak power fee** – Optionally, the calculation includes a peak power fee
   (€/kW). The fee is applied to the hour with the highest average power during
   the charging window. Users can disable this component in the UI.
4. **Optimization** – Every possible charging window is evaluated to locate the
   lowest combined cost of spot prices, energy margin, distribution fees and the
   peak power fee.

## Pricing configurations

Multiple distribution companies are supported. Each pricing table is stored in
its own file under [`config/pricing/`](config/pricing/). The manifest file
[`config/pricing/manifest.json`](config/pricing/manifest.json) defines which
pricing options appear in the UI and which one is the default (`Helen
Sähköverkko`).

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

Each `configPath` points to a JSON file that follows the same structure: a
`siirto` (distribution) section and an optional `teho` (power) section, both
containing `tiers` arrays that describe when a fee is active. The file
[`config/pricing/helen.json`](config/pricing/helen.json) serves as an example.
When adding a new pricing configuration, create the corresponding JSON file and
list it in the manifest with an ID, user-facing name and file path. The app
reports configuration errors to the user and ignores invalid pricing files.

## User interface highlights

- **Pricing selector** – Choose the distribution company. The page URL updates
  accordingly (e.g. `/helen`, `/vantaan-energia`), making it easy to share a
  link to a specific configuration. Reloading the page restores the correct
  pricing based on the path.
- **Refresh prices** – Reloads spot prices and the selected pricing details.
- **Save settings** – Stores charging power, energy, peak power toggle, full
  battery option, energy margin and selected pricing in the browser’s
  `localStorage`.
- **Share link** – Copies the current URL (including the pricing path) to the
  clipboard so settings can be shared.
- **Sliders** – Adjust the required energy, charging power and energy margin.
  The margin adds a user-defined premium to the spot price (range 0.01–1.20
  €/kWh) and affects all energy-dependent calculations.

The charging view explicitly displays the charging duration in the format
`Charging time ...` instead of the previous “Charging (15 min)” label.

## Running the app locally

The app is a static site that runs entirely in the browser. To try it locally,
open `index.html` in a modern browser. You can verify that the pricing API is
reachable with:

```bash
curl -I https://api.spot-hinta.fi/Today
```

If the API is unavailable or returns an error, the UI informs the user about
missing price data and does not display outdated fallback prices.

## Further development

There is plenty of room to expand and refine the project—feel free to experiment
with new features, pricing models, deployment options or automated tests.
