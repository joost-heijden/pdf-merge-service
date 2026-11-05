# PDF-bijlagen uit een mail samenvoegen met n8n

1. Ontvang een mail via de bestaande mailintegratie en haal de echte PDF-bijlagen als binaire bestanden op.
2. Tel uitsluitend de PDF-bijlagen. Bij nul PDF's volgt de bestaande uitzonderingsroute; bij één PDF gaat het origineel verder.
3. Bij meer dan één PDF maakt n8n één aanvraag per mail naar `POST /v1/merge`. Behoud de volgorde van de bijlagen in `ordered_parts` en laat `pages` weg om alle pagina's per document op natuurlijke volgorde te gebruiken.
4. Controleer de response en zet `output_document.data_base64` met Convert to File → Move Base64 String to File om naar een binair PDF-veld.
5. Gebruik de samengestelde PDF als vervanging van de losse PDF's in de volgende stap. Bij een fout volgt handmatige controle.

## HTTP Request

- Methode: POST; URL: de goedgekeurde HTTPS-host van deze service plus `/v1/merge`.
- Authenticatie: n8n Header Auth-credential met `Authorization: Bearer <token>`.
- Body: Form-Data met één tekstveld `manifest` (JSON-string) en één n8n Binary File-veld per document. De veldnamen moeten overeenkomen met `documents[].field_name`.
- Response Format: JSON. Niet-succesvolle HTTP-statussen moeten de verwerking blokkeren.
- Zend alle PDF's van dezelfde mail in één multipart-aanvraag. Een lus met één losse aanvraag per PDF voegt de bestanden niet samen. Bouw de velden voor een wisselend aantal bijlagen expliciet op en test dit met de gebruikte n8n-versie.

Voorbeeld voor twee bijlagen:

```json
{
  "schema_version": "1",
  "request_id": "mail-001",
  "group_id": "mail-001",
  "output_name": "merged.pdf",
  "documents": [
    {"document_id": "attachment-1", "field_name": "doc1"},
    {"document_id": "attachment-2", "field_name": "doc2"}
  ],
  "ordered_parts": [
    {"document_id": "attachment-1"},
    {"document_id": "attachment-2"}
  ]
}
```

Controleer `status`, de correlatie-ID's, bronlijst, paginamanifest, paginatelling en SHA-256/grootte van de gedecodeerde uitvoer. Een verwijzing of bestandsnaam alleen bevat geen PDF-bytes. Houd rekening met circa 33% extra omvang voor Base64 en de opslaginstellingen van n8n-executions.

n8n Cloud heeft een beveiligde netwerkroute naar de host nodig; een interne server of localhost is niet automatisch bereikbaar. Gebruik geen publieke testdienst voor vertrouwelijke documenten. Test de volledige aanleverroute met synthetische documenten voordat echte mails worden verwerkt.
