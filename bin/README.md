# pwsh-ast-parser

CLI che analizza sintassi PowerShell e restituisce una rappresentazione JSON dell'albero sintattico. Interfaccia descritta qui come blackbox: il chiamante interagisce solo con eseguibile, stdin, stdout e codice di uscita.

Il testo PowerShell **non viene eseguito**. Il parser non determina se un comando sia sicuro, consentito o quale effetto avrebbe.

## Requisiti runtime

Le release sono self-contained e compilate con Native AOT: non serve installare PowerShell, `pwsh`, Node.js o .NET sulla macchina chiamante. Usare l'artefatto pubblicato per il sistema operativo e l'architettura corretti.

RID configurati nel progetto:

- `win-x64`
- `linux-x64`
- `osx-x64`
- `osx-arm64`

Native AOT segnala warning di trimming/AOT provenienti soprattutto da dipendenze PowerShell; consultare output di publish e validare ogni artefatto prima della distribuzione.

### Pubblicazione Windows + Linux

Da Windows, con .NET 10 SDK e Podman installati, eseguire:

```powershell
.\scripts\Publish-All.ps1
```

Lo script avvia i due publish in parallelo: Windows nativo sull'host (`win-x64`) e Linux nativo nel container definito in `Dockerfile` (`linux-x64`). Copia gli artefatti in:

- `dist/win-x64/` — `pwsh-ast-parser.exe`
- `dist/linux-x64/` — `pwsh-ast-parser` e archivio `.tar.gz` con permesso eseguibile preservato

Usa Podman machine; se non è già attiva, lo script tenta di avviarla. Il Dockerfile usa immagine SDK .NET 10 Native AOT basata su Ubuntu Noble. Gli altri RID configurati nel progetto non sono prodotti da questo script.

## Invocazione

Il programma elabora una richiesta per processo. Inviare un singolo documento JSON UTF-8 su stdin e chiudere stdin (EOF); leggere la risposta JSON da stdout. Non passare il testo PowerShell come argomento CLI.

### Esempi

Windows PowerShell:

```powershell
$request = '{"protocolVersion":1,"command":"Get-ChildItem -Force"}'
$request | .\pwsh-ast-parser.exe
```

Linux / macOS:

```sh
printf '%s' '{"protocolVersion":1,"command":"Get-ChildItem -Force"}' \
  | ./pwsh-ast-parser
```

Per conoscere le versioni dell'helper e del parser PowerShell inclusi:

```sh
./pwsh-ast-parser --version
```

`--version` scrive una riga di testo su stdout e non legge stdin. Non combinarlo con una richiesta JSON.

## Request protocollo v1

```json
{
  "protocolVersion": 1,
  "command": "Get-ChildItem -Force"
}
```

- `protocolVersion`: intero obbligatorio, attualmente `1`.
- `command`: stringa obbligatoria contenente testo PowerShell; può essere vuota o multilinea.
- Le proprietà aggiuntive sono ignorate.
- Dimensione massima della richiesta: **1.048.576 byte** (1 MiB), inclusi JSON e testo PowerShell.

## Response

Ogni richiesta processata produce un oggetto JSON con una riga finale. Nomi proprietà sono camelCase; proprietà opzionali sono presenti con valore `null`.

```json
{
  "protocolVersion": 1,
  "ok": true,
  "root": {
    "kind": "script",
    "extent": {
      "startOffset": 0,
      "endOffset": 20,
      "startLine": 1,
      "startColumn": 1,
      "endLine": 1,
      "endColumn": 21
    },
    "children": []
  },
  "parseErrors": [],
  "error": null
}
```

L'esempio è abbreviato: i nodi reali includono altri campi, anche quando il valore è `null` o l'array è vuoto.

### Campi della risposta

- `protocolVersion`: versione del protocollo della risposta.
- `ok`: `true` se richiesta e parsing sono stati elaborati, anche quando `parseErrors` non è vuoto. `false` per errori di richiesta o operativi.
- `root`: radice dell'albero (`null` in caso di errore di richiesta o operativo).
- `parseErrors`: array degli errori sintattici PowerShell; può essere non vuoto insieme a `ok: true` e a un albero parziale.
- `error`: `null` se la richiesta è stata elaborata; altrimenti oggetto con `code` e `message`.

### Nodi, elementi e valori

Ogni nodo espone:

- `kind`: tipo del nodo, per esempio `script`, `pipeline`, `command`, `literal`, `variable` o `expandableString`. Altri tipi sono possibili; i consumatori dovrebbero ignorare tipi sconosciuti preservando la traversata dei discendenti.
- `extent`: posizione nel testo sorgente (`null` quando non disponibile).
- `children`: nodi figli, ordinati secondo la struttura sintattica.
- `commandName`, `invocationOperator`, `elements`, `text`, `value`: dettagli aggiuntivi, valorizzati quando applicabili; altrimenti possono essere `null`.

Un nodo `command` espone `commandName`, `invocationOperator` (`null`, `&` o `.`) ed `elements` nell'ordine sorgente. Ogni elemento ha `kind` (`parameter` o `argument`), `name`, `spelling`, `value`, `node` ed `extent`. Per un parametro, `name` contiene il nome senza trattino; `spelling` conserva il testo sorgente. `value` e `node` rappresentano l'argomento associato, se presente.

Un valore (`value`, `commandName` o valore di elemento) ha forma:

```json
{ "kind": "literal", "value": "Get-ChildItem", "text": null }
```

`kind` distingue valori `literal`, `dynamic` ed `expression`; il contenuto dinamico o non letterale è riportato in `text`, senza espansione o valutazione. Il campo `value` può contenere scalari JSON (stringa, numero, booleano o `null`).

Le posizioni `extent` hanno offset iniziale/finale in unità UTF-16 e righe/colonne 1-based. Gli offset seguono la convenzione degli indici stringa .NET.

### Errori sintattici PowerShell

Gli errori del parser sono restituiti in `parseErrors`, ciascuno con:

```json
{
  "errorId": "...",
  "message": "...",
  "incompleteInput": false,
  "extent": {
    "startOffset": 0,
    "endOffset": 1,
    "startLine": 1,
    "startColumn": 1,
    "endLine": 1,
    "endColumn": 2
  }
}
```

Sono distinti dagli errori del protocollo: non causano da soli `ok: false` né un codice di uscita non zero.

### Errori di richiesta e operativi

Quando `ok` è `false`, `root` è `null`, `parseErrors` è vuoto e `error` contiene `code` e `message`. Codici attualmente emessi:

| Codice | Significato |
| --- | --- |
| `invalid_json` | stdin non contiene un singolo documento JSON valido |
| `invalid_request` | root non è un oggetto, `protocolVersion` non è un intero oppure `command` non è una stringa |
| `unsupported_protocol_version` | versione richiesta diversa da `1` |
| `input_too_large` | richiesta oltre il limite di 1 MiB |
| `internal_error` | errore operativo non esposto in dettaglio |

## Codici di uscita

| Codice | Significato |
| --- | --- |
| `0` | richiesta elaborata, anche se parsing ha prodotto errori sintattici |
| `1` | errore di richiesta o operativo |

Leggere sempre la risposta JSON: il codice di uscita da solo non descrive il risultato del parsing.

## Compatibilità

Il protocollo è versionato tramite `protocolVersion`. Validare la versione ricevuta prima di interpretare la struttura. I nodi sono una proiezione sintattica, non una garanzia di risoluzione di alias, variabili, moduli, binding dei parametri o comportamento a runtime. Non interpretare `ok: true` come indicazione che lo script sia valido o sicuro.
