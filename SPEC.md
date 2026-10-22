# SPEC — Helper .NET per parsing PowerShell

**Stato:** proposta implementativa  
**Versione protocollo iniziale:** 1  
**Target runtime:** .NET 10  
**Native AOT:** fuori ambito
**Trimming:** nice to have

## 1. Scopo

Specificare un eseguibile cross-platform che riceve testo PowerShell, lo analizza con il parser PowerShell e restituisce una proiezione JSON dell’albero sintattico. L’eseguibile non interpreta il rischio e non esegue lo script.

La proiezione deve conservare struttura sufficiente perché un consumer TypeScript possa visitare i nodi e implementare analisi proprie senza dipendere da tipi .NET o da serializzazione dell’intero AST PowerShell.

## 2. Requisiti funzionali

### 2.1 Parsing

1. Usare API parser statiche PowerShell, in particolare `System.Management.Automation.Language.Parser.ParseInput` tramite `Microsoft.PowerShell.SDK` compatibile con .NET 10.
2. Analizzare il testo ricevuto senza creare un runspace e senza eseguire lo script.
3. Non risolvere alias, variabili, moduli, funzioni, command discovery o binding dei parametri. Il risultato rappresenta la sintassi scritta, non l’esito dell’esecuzione PowerShell.
4. Restituire l’albero anche quando il parser trova errori recuperabili. Gli errori devono essere dati espliciti della risposta, non log mescolati al JSON.
5. Conservare le posizioni sorgente dei nodi utili: offset iniziale/finale e riga/colonna iniziale/finale. Usare posizioni 1-based per righe e colonne; offset UTF-16 per interoperabilità con stringhe .NET e API AST PowerShell.
6. Non valutare né espandere `$variables`, subexpression, command substitution, stringhe interpolabili o espressioni dinamiche. Contrassegnarli come dinamici/non letterali.

### 2.2 Proiezione AST e traversal

L’AST PowerShell nativo non deve essere serializzato direttamente. Il helper deve produrre una proiezione JSON esplicita, piccola e versionata, composta da nodi discriminati. Questo richiede nel helper una visita meccanica dell’AST per costruire il DTO; tale visita non deve contenere analisi di rischio. La traversata semantica dei nodi e ogni decisione restano al consumer TypeScript.

La proiezione deve:

- mantenere relazioni parent/child necessarie alla visita ricorsiva;
- permettere di trovare ogni `CommandAst`, anche dentro pipeline, statement block, scriptblock, espressioni annidate, subexpression e invocazioni con `&` o `.`;
- conservare per ogni invocazione nome scritto, operator di invocazione se presente, ordine degli elementi, parametri, argomenti ed espressioni annidate;
- distinguere valori letterali da variabili, stringhe interpolabili, espressioni e nodi non staticamente determinabili;
- preservare spelling e maiuscole/minuscole originali. La semantica case-insensitive di PowerShell e il riconoscimento di alias/abbreviazioni appartengono al consumer, non al parser;
- mantenere un campo `kind` per i nodi, così il consumer può ignorare nodi non pertinenti senza perdere i discendenti;
- essere deterministica: stesso testo e stessa versione del parser producono la stessa struttura, salvo messaggi localizzati degli errori.

Campi concettuali richiesti per una command invocation:

- `kind: "command"`;
- `commandName`: valore statico quando disponibile, altrimenti nodo dinamico;
- `invocationOperator`: `null`, `"&"`, `"."` o altro valore conservato dal parser;
- `elements`: sequenza ordinata di elementi command, inclusi parametri e argomenti;
- `children`: nodi sintattici annidati, visitabili ricorsivamente;
- `extent`: posizione sorgente.

I parametri devono conservare almeno nome, spelling, eventuale argomento associato e posizione. Gli argomenti devono distinguere almeno stringa/numero/bool letterale, variabile, stringa espandibile, espressione, scriptblock e forma sconosciuta. Un valore dinamico non deve essere appiattito a una stringa che sembri letterale.

Esempio illustrativo, non vincolante per ogni nome di campo:

```json
{
  "kind": "command",
  "commandName": { "kind": "literal", "value": "Remove-Item" },
  "invocationOperator": null,
  "elements": [
    { "kind": "parameter", "name": "Recurse", "spelling": "-Recurse" },
    { "kind": "parameter", "name": "Force", "spelling": "-Force" },
    { "kind": "argument", "value": { "kind": "literal", "value": "file.txt" } }
  ],
  "children": [],
  "extent": { "startOffset": 0, "endOffset": 39, "startLine": 1, "startColumn": 1, "endLine": 1, "endColumn": 40 }
}
```

I nomi e lo schema definitivi devono essere definiti da DTO C# espliciti e documentati. Il DTO non deve esporre oggetti .NET serializzati per reflection né riferimenti ciclici all’AST originale.

### 2.3 Errori

La risposta deve distinguere:

- **errore di parsing PowerShell:** `ParseError` con `errorId`, messaggio, `incompleteInput` e extent; parsing del protocollo riuscito;
- **errore di protocollo:** JSON malformato, versione non supportata, campo mancante o tipo errato;
- **errore operativo:** eccezione interna, errore di serializzazione o limite di risorse superato.

In presenza di errori sintattici, includere AST parziale solo se restituito in modo valido dal parser. Non inventare nodi per porzioni non analizzate.

### 2.4 Limiti e comportamento deterministico

- Definire e documentare un limite massimo configurabile o costante alla dimensione del comando in input.
- Non accedere a file, rete, processi, moduli PowerShell o variabili d’ambiente per interpretare il testo.
- Il helper non deve contenere script/profili PowerShell né invocare `pwsh`/`powershell.exe` per analizzare il testo.
- Il processo deve terminare in modo controllato su input oltre limite o request non valida; nessuna eccezione non gestita deve contaminare stdout.

## 3. Protocollo CLI

### 3.1 Trasporto

Modalità iniziale: un processo per richiesta.

- Leggere un singolo documento JSON da stdin fino a EOF.
- Scrivere esattamente un documento JSON su stdout.
- Usare stderr solo per diagnostica tecnica non necessaria al protocollo.
- Non scrivere banner, progress, stack trace o messaggi localizzati su stdout.
- Non passare il testo PowerShell come argomento CLI: usare stdin per evitare problemi di escaping, quoting e limiti della command line.

### 3.2 Request protocollo v1

```json
{
  "protocolVersion": 1,
  "command": "Get-ChildItem"
}
```

`command` è una stringa, può essere vuota o contenere newline. Campi sconosciuti possono essere ignorati solo se non compromettono l’interpretazione; `protocolVersion` mancante o non supportato è errore di protocollo.

### 3.3 Response protocollo v1

```json
{
  "protocolVersion": 1,
  "ok": true,
  "root": { "kind": "script", "children": [] },
  "parseErrors": []
}
```

- `ok: true` significa che request e risposta sono state elaborate; non significa che il testo sia sintatticamente valido.
- Gli errori di parsing sono riportati in `parseErrors`; possono coesistere con AST parziale.
- `ok: false` contiene un errore di protocollo o operativo strutturato; non contiene stack trace.
- Usare exit code `0` per request processata, anche se contiene errori sintattici; exit code non-zero per errore di protocollo o operativo. Il consumer deve sempre leggere la risposta JSON, non basarsi solo sull’exit code.

La forma esatta di `error` deve essere stabile e versionata, ad esempio `code`, `message` e dettagli sicuri.

## 4. Requisiti non funzionali

### 4.1 Piattaforme e distribuzione

- Target framework `net10.0`.
- Produrre artefatti self-contained single-file separati per RID supportati; la lista RID supportata deve essere dichiarata nel progetto e verificata in CI. Minimo previsto: Windows x64, Linux x64, macOS x64 e macOS arm64; aggiungere ARM64 Windows/Linux solo dopo build e smoke test dedicati.
- Native AOT non va abilitato.
- Trimming è un obiettivo subordinato alla correttezza: abilitarlo solo se `Microsoft.PowerShell.SDK` e DTO funzionano dopo publish. Analizzare warning di trimming, aggiungere roots/descriptors solo se necessari e testare il binario pubblicato. Se il trimming rompe o non è supportato dal parser, disabilitarlo e documentare motivazione; mai distribuire un artefatto che compila ma perde nodi/API a runtime.
- Nessuna dipendenza runtime da installazione separata di PowerShell, Node.js o .NET, salvo decisione esplicita documentata.

### 4.2 Robustezza e compatibilità

- DTO e protocollo JSON sono API pubbliche tra processi: mantenere `protocolVersion` e aggiungere campi in modo compatibile.
- Testare compatibilità con comandi multi-linea, pipeline, scriptblock, subexpression, chiamata tramite operator `&`/`.`, quoting, here-string, parametri con/senza valore, valori dinamici e input non valido.
- Ogni versione distribuita deve avere smoke test sul binario single-file per ciascun RID supportato.
- Registrare versione dell’helper e versione PowerShell parser/SDK in `--version` o metadata di build, senza emettere testo aggiuntivo nel protocollo standard.

## 5. Fuori ambito dell’helper

L’helper non deve:

- decidere se comando è pericoloso, consentito o da bloccare;
- implementare matcher, regex, pattern configurati, allow-list, auto-deny o case-insensitive;
- leggere o modificare `guardrail.json`;
- mostrare prompt/notifiche o conoscere UI/session grant;
- eseguire comandi, scriptblock, espansioni, alias o binding dei parametri;
- fare access control su file, path extraction, policy matching o Path Access;
- conoscere API/eventi di Pi o tipi TypeScript dell’estensione.

## 6. Criteri di accettazione

1. `Parser.ParseInput` analizza input PowerShell senza eseguirlo.
2. CLI stdin/stdout rispetta protocollo v1; stdout contiene solo JSON.
3. Risposta rappresenta comandi top-level e annidati con ordine, parametri, argomenti, extent e valori dinamici distinguibili.
4. Errori PowerShell vengono restituiti come parse errors; input/protocollo/errore operativo sono distinti.
5. Nessuna regola di rischio o decisione Permission Gate è presente nel progetto .NET.
6. Test unitari coprono parser, DTO, protocollo ed error handling.
7. Publish single-file self-contained passa smoke test sui RID supportati; trimming è verificato sul binario pubblicato o esplicitamente disattivato con motivazione.
8. Test di sicurezza dimostrano che testo ricevuto non viene eseguito e che helper non avvia PowerShell come processo secondario.

## 7. Contesto d’integrazione (separato dalla specifica dell’helper)

Questo capitolo descrive il consumer previsto; non amplia le responsabilità funzionali del helper.

- Il tool Pi chiamato `powershell` passa input con `command` e `timeout`. L’estensione invia al helper solo `command`; il timeout del tool non è sintassi da analizzare.
- Integrazione iniziale limitata al Permission Gate per comandi PowerShell. Policies e Path Access non fanno parte di questa fase.
- L’estensione TypeScript lancia il binario helper, valida `protocolVersion`, riceve il DTO e percorre l’albero con walker TypeScript.
- Tutte le regole di rischio strutturali PowerShell, i matcher testuali, la gestione `caseInsensitive`, le allow-list, gli auto-deny e le decisioni UI restano TypeScript.
- Il risultato viene adattato al contratto comune del Permission Gate (`DangerousCommandMatch`); il helper non decide il blocco.
- Eventi Bash continuano a usare parser/walker/matcher Bash esistenti. Non passare testo PowerShell al parser Bash.
- Integrazione deve definire comportamento esplicito per binario mancante, timeout, versione protocollo incompatibile e parse error; non trasformare silenziosamente questi casi in “comando sicuro”.
