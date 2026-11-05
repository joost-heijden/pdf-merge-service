# PDF Merge Service

A small self-hosted HTTP service to inspect and merge PDF files. Built for n8n workflows and reusable by any HTTP client. The service processes documents in memory and does not send them to an external PDF provider.

**Typical workflow:** receive an email, collect its PDF attachments, merge them in attachment order when there is more than one, and use the resulting PDF instead of the individual PDFs. Grouping is controlled by the caller; the service follows an explicit page order.

This is a Node.js service, with a Docker configuration, synthetic sample documents and automated tests. Hosting the source on GitHub does not host or run the PDF service. No email credentials, customer documents or organization-specific workflows are included.

The setup and API guide below is in Dutch. The [n8n integration guide](docs/n8n.md) describes the email attachment flow. Contributions and translations are welcome.

## Snel lokaal starten

Benodigd: Node.js 24 en pnpm 11.25.0. Het project bevat een lockfile en gebruikt Fastify, `@fastify/multipart` en `pdf-lib`.

```sh
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm test
```

Maak een lokale `.env` met een willekeurig token zonder het token af te drukken. Dit commando overschrijft geen bestaand bestand:

```sh
node --input-type=module -e "import {randomBytes} from 'node:crypto'; import {writeFileSync} from 'node:fs'; writeFileSync('.env', 'PDF_API_TOKEN=' + randomBytes(32).toString('hex') + '\n', {flag:'wx', mode:0o600});"
node --env-file=.env src/server.js
```

De API luistert standaard op `http://127.0.0.1:3000`. Een al geëxporteerde procesomgeving kan ook worden gebruikt met `pnpm start`. Het startscript laadt `.env` niet zelf. `GET /healthz` is zonder token bereikbaar en geeft alleen een basisstatus.

Een volledige lokale demonstratie kan zonder blijvende server of `.env`:

```sh
pnpm demo
```

Dit start tijdelijk een API op localhost met een willekeurig testtoken, uploadt de twee fictieve voorbeeld-PDF's en schrijft de samengevoegde PDF met drie pagina's plus een controleverslag naar `work/demo/`. De scan wordt eerst geüpload maar komt volgens het plan als laatste in de uitvoer. De server sluit na de test. Een eigen uitvoermap kan worden opgegeven met `node scripts/demo.mjs /pad/naar/uitvoer`.

## API

`POST /v1/inspect` en `POST /v1/merge` vereisen `Authorization: Bearer <PDF_API_TOKEN>`. Het token bevat 32 tot 512 afdrukbare ASCII-tekens zonder spaties. De body is `multipart/form-data` met precies één tekstveld `manifest` dat JSON bevat en één uniek benoemd bestandsveld per PDF. Bestandsnamen en uploadvolgorde bepalen de verwerking niet.

Voor inspectie:

```json
{
  "schema_version": "1",
  "request_id": "demo-001",
  "documents": [
    {"document_id": "invoice", "field_name": "doc1"},
    {"document_id": "specification", "field_name": "doc2"}
  ]
}
```

Een document mag optioneel `sha256` bevatten. De API berekent de checksum altijd zelf en wijst een afwijking af. Uploadvelden moeten exact overeenkomen met het manifest: ontbrekende, dubbele of extra bestanden worden afgewezen.

Een merge-aanvraag voegt aan dat manifest toe:

```json
{
  "group_id": "one-invoice",
  "output_name": "factuur.pdf",
  "ordered_parts": [
    {"document_id": "invoice", "pages": [1, 2]},
    {"document_id": "specification"}
  ]
}
```

Pagina's tellen vanaf 1. Zonder `pages` worden alle pagina's van dat onderdeel in hun oorspronkelijke volgorde gebruikt. Alle pagina's van alle aangeleverde documenten moeten precies één keer voorkomen. Ontbrekende, dubbele of ongeldige pagina's blokkeren de aanvraag. Document-ID's mogen maximaal 512 tekens zonder controltekens bevatten. `request_id` begint met een letter of cijfer, bevat alleen letters, cijfers, punten, underscores, dubbele punten en koppeltekens, en is maximaal 80 tekens. Een uploadveld begint met een letter en bevat maximaal 64 letters, cijfers en underscores; `manifest` is gereserveerd. `output_name` is een korte ASCII-bestandsnaam die op `.pdf` eindigt en bevat geen pad.

Een geslaagde merge geeft JSON met de **werkelijke PDF-bytes in Base64** terug:

```json
{
  "schema_version": "1",
  "request_id": "demo-001",
  "group_id": "one-invoice",
  "status": "complete",
  "original_manifest": [
    {"document_id": "invoice", "field_name": "doc1", "sha256": "...", "size_bytes": 1234, "page_count": 2}
  ],
  "output_document": {
    "name": "factuur.pdf",
    "mime": "application/pdf",
    "encoding": "base64",
    "data_base64": "JVBER...",
    "sha256": "...",
    "size_bytes": 3456,
    "page_count": 3
  },
  "page_manifest": [
    {"output_page": 1, "document_id": "invoice", "page": 1},
    {"output_page": 2, "document_id": "invoice", "page": 2},
    {"output_page": 3, "document_id": "specification", "page": 1}
  ],
  "warnings": [],
  "checks": {"structure": "parsed", "rendering": "not_checked", "text_layer": "not_checked"}
}
```

Dit is een verkort voorbeeld: een echte `original_manifest` bevat ieder geüpload document en volledige SHA-256-waarden. Inspectie geeft de bronmetadata en controles terug zonder `output_document`. Het paginamanifest beschrijft herkomst en volgorde; het is geen bewijs dat facturen inhoudelijk bij elkaar horen of dat iedere pagina correct rendert.

Fouten gebruiken een niet-succesvolle HTTP-status en deze vorm:

```json
{
  "schema_version": "1",
  "status": "rejected",
  "error": {"code": "EXAMPLE_CODE", "message": "Korte foutomschrijving"},
  "request_id": "opaque-server-id"
}
```

De fout-ID wordt door de server gemaakt en is bedoeld voor technische opvolging. Mogelijke statusgroepen: `400` ongeldige aanvraag, `401` authenticatie, `413` limiet, `415` bestandstype, `422` onbruikbare PDF of samenvoegplan, `503` capaciteit, `504` verwerkingstime-out en `500` interne fout. Het concrete `error.code` geeft de oorzaak aan.

## Limieten en verwerking

| Instelling | Standaard |
| --- | --- |
| `HOST` | `127.0.0.1` |
| `PORT` | `3000` |
| `PDF_MAX_DOCUMENTS` | `20` |
| `PDF_MAX_INPUT_BYTES` | `20971520` (20 MiB, alle uploads samen) |
| `PDF_MAX_OUTPUT_BYTES` | `20971520` (20 MiB PDF-uitvoer vóór Base64) |
| `PDF_MAX_PAGES` | `500` |
| `PDF_JOB_TIMEOUT_MS` | `10000` |
| `PDF_MAX_CONCURRENT` | `2` |
| `PDF_REQUEST_TIMEOUT_MS` | `30000` |

De document-, byte- en paginalimieten kunnen via de omgeving worden verlaagd, maar niet boven de genoemde standaardwaarden worden verhoogd. De overige bovengrenzen zijn 60000 ms verwerkingstijd, 4 gelijktijdige aanvragen en 120000 ms request-time-out. Een ongeldige configuratie blokkeert de start.

Base64 maakt de PDF-overdracht ongeveer 33% groter. Een PDF van 20 MiB wordt circa 26,7 MiB aan Base64, plus JSON. Houd daarmee rekening bij een reverse proxy, n8n-geheugengebruik en execution-opslag. De bestandslimieten hierboven tellen de echte PDF-bytes.

PDF-verwerking gebeurt in een afzonderlijke Node-worker met een heaplimiet van 128 MiB en een beëindigbare verwerkingstijd. Een workerlimiet is geen limiet voor het totale procesgeheugen; buffers en gelijktijdige aanvragen vragen extra geheugen. De meegeleverde Compose-configuratie begrenst de container daarom ook.

De dienst bewaart geen documenten op schijf en doet geen uitgaande API-aanroepen. Verwerking en antwoorden bestaan tijdelijk in het geheugen; dit biedt geen garantie op veilig wissen van geheugen. Logs bevatten alleen een door de server gemaakte aanvraag-ID, status en looptijd, geen URL, bestandsinhoud, bestandsnamen, tokens of volledige requests. Hosting, proxies, n8n en de mailketen hebben hun eigen opslag- en logginginstellingen.

## Afbakening

- Alleen bestaande PDF's inspecteren en samenvoegen; geen Excel-/HTML-conversie, OCR of losse JPG/PNG-conversie.
- Een scan die al in een PDF zit kan worden verwerkt. De dienst controleert niet of de volgende verwerkingsstap een tekstlaag nodig heeft.
- Versleutelde PDF's, formulieren, handtekeningen, PDF-lagen en herkende actieve acties worden afgewezen om stil verlies of verandering van documentfuncties te voorkomen.
- De controles vormen geen volledige PDF-sanitizer, antiviruscontrole, PDF/A-validatie of rendercontrole. Ook parser-succes garandeert geen correcte weergave van iedere PDF.
- Geen herkenning van factuurgroepen: leverancierregels en paginavolgorde blijven expliciet onderdeel van de n8n-aanvraag.
- De uitvoer gebruikt vaste technische metadata. De volgorde is expliciet; dezelfde outputchecksum na wijzigingen aan de code of PDF-bibliotheek wordt niet gegarandeerd.

## Docker

Met dezelfde `.env` kan de dienst worden gebouwd en gestart:

```sh
docker compose up --build -d
docker compose logs --tail=20
curl --fail http://127.0.0.1:3000/healthz
docker compose down
```

Compose draait als niet-root gebruiker, met een alleen-lezen bestandssysteem, verwijderde Linux-capabilities, `no-new-privileges`, maximaal 512 MiB geheugen en één CPU. Alleen `127.0.0.1:3000` van de host wordt gepubliceerd. Binnen de container luistert de API op `0.0.0.0`.

Een productiehost, HTTPS en bereikbaarheid vanuit n8n Cloud moeten door de beheerder worden ingericht en getest. Een localhost-adres op je eigen machine is niet bereikbaar vanuit n8n Cloud. De containerconfiguratie is meegeleverd; zie GitHub Actions voor de buildstatus.

## n8n

See [docs/n8n.md](docs/n8n.md) for a minimal email attachment workflow. No workflow is automatically installed or activated by this repository.

## License

MIT. See [LICENSE](LICENSE). Dependencies retain their own licenses.

## References

- [n8n HTTP Request](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest)
- [n8n Convert to File](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.converttofile)
- [pdf-lib](https://github.com/Hopding/pdf-lib)
