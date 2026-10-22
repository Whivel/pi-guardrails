# SPEC — Integrazione PowerShell nel Permission Gate

**Stato:** specifica implementativa  
**Ambito:** estensione TypeScript `permission-gate`  
**Helper parser:** `bin/pwsh-ast-parser` e `bin/pwsh-ast-parser.exe` (blackbox; contratto in `bin/README.md` e responsabilità in `SPEC.md`)

## 1. Scopo

Aggiungere il controllo dei comandi inviati tramite tool Pi `powershell`, mantenendo nell’estensione TypeScript tutta l’analisi del rischio e ogni decisione di allow, prompt o block.

L’helper .NET esegue soltanto parsing PowerShell e restituisce AST JSON. Non conosce i matcher, la configurazione Guardrails, gli eventi Pi o la UI; non esegue il comando.

## 2. Ambito e non-obiettivi

### In scope

- Intercettare `toolName: "powershell"` e leggere `event.input.command`.
- Analizzare l’AST con l’eseguibile per piattaforma appropriata, disponibile in `bin/`.
- Traversare AST e valutare matcher strutturali in TypeScript.
- Applicare al comando PowerShell i pattern configurati e il flusso Permission Gate esistente.
- Conservare eventi, prompt, grant e metadata indicando origine `powershell`.

Il campo tool `timeout` non fa parte del comando e non va passato al parser.

### Fuori scope

- Policies, Path Access, estrazione dei percorsi dai comandi PowerShell.
- Interpretare comandi `pwsh` inseriti in chiamate `bash`: questo caso resta coperto dal guardrail Bash esistente.
- Risolvere alias, variabili, moduli, command discovery, binding dei parametri o comportamento runtime PowerShell.
- Modificare i default Bash o le policy esistenti.
- Dare al helper responsabilità di sicurezza o di decisione.

## 3. Stato attuale e comportamento richiesto

Oggi `extensions/permission-gate/index.ts` accetta soltanto eventi riconosciuti da `isToolCallEventType("bash", event)`. Per Bash crea un’azione `kind: "command"`, controlla grant e auto-deny, poi applica `createPermissionGateRule`, prompt e risultati.

La modifica deve aggiungere il percorso PowerShell senza cambiare il comportamento Bash. L’evento PowerShell va riconosciuto per il suo nome tool e validato prima dell’uso: `input.command` deve essere una stringa. Non inoltrare l’intero input o il campo `timeout` come sorgente.

## 4. Flusso d’integrazione

```text
Pi tool_call
  ├─ bash       → percorso/parser/matcher Bash esistente, invariato
  └─ powershell → command string
                    ├─ grant / allowedPatterns
                    ├─ autoDenyPatterns sul testo originale
                    ├─ parser helper se matcher strutturali abilitati
                    ├─ walker AST e matcher PowerShell in TypeScript
                    ├─ pattern dangerous configurati sul testo originale
                    └─ flusso comune Permission Gate: warning, prompt o block
```

Mantenere l’ordine di precedenza attuale: grant o `allowedPatterns` prima, poi `autoDenyPatterns`, quindi rilevamento del rischio e normale flusso di conferma. Non introdurre un ordine diverso per PowerShell.

Il routing deve essere esplicito per dialetto. Non inviare mai il testo del tool `powershell` a `@aliou/sh` o ai matcher Bash. L’azione condivisa resta `kind: "command"`; il dialetto va passato esplicitamente al percorso di matching o al rule factory, senza inferirlo da parsing euristico del testo.

## 5. Parser adapter e DTO

### Responsabilità TypeScript

Aggiungere un adapter del helper nell’area `extensions/permission-gate/`. Responsabilità:

1. Selezionare l’artefatto per OS/architettura, senza invocare una shell.
2. Avviare il processo direttamente (`spawn`/`execFile` equivalente), passare una request JSON su stdin e leggere la response JSON da stdout.
3. Separare stderr da stdout; non interpretare messaggi diagnostici come protocollo.
4. Imporre timeout e limiti a input/output del processo. Il comando non va messo negli argomenti CLI.
5. Validare `protocolVersion`, `ok`, `root`, `parseErrors` e forma minima dei nodi prima di restituire un DTO tipizzato a TypeScript.

Seguire il protocollo v1 di `bin/README.md`: request `{ protocolVersion: 1, command }`, limite input di 1 MiB, una response JSON per processo. Exit code da solo non determina l’esito: leggere sempre la response. `--version` è un’invocazione separata, non parte del protocollo request/response.

### Walker TypeScript

Il DTO deve restare proiezione del parser, non contenere classificazioni di rischio. Il walker e i matcher PowerShell vivono in TypeScript.

- Visitare ricorsivamente l’albero e ogni comando annidato, incluse pipeline, scriptblock, subexpression e invocazioni con `&` o `.` rappresentate dal parser.
- Usare `kind` per riconoscere i nodi noti e proseguire attraverso i discendenti dei nodi sconosciuti.
- Conservare `extent`, ordine degli elementi, spelling originale e distinzione fra valore literal, dynamic ed expression.
- Non trattare un valore dinamico come un literal appiattito; non valutare variabili o espressioni.
- Definire e testare una sola via canonica per visitare nodi figli: la response espone sia `children` sia `elements[].node`; il walker deve evitare doppie visite o omissioni.
- Non dipendere da proprietà .NET o da tipi interni di `System.Management.Automation`.

DTO e mapping devono essere versionati/validati rispetto al protocollo helper. Il helper può aggiungere nuovi `kind`; il consumer deve tollerarli senza perdere i discendenti.

## 6. Matcher PowerShell

Aggiungere un checker PowerShell TypeScript distinto dal checker Bash, con risultato comune `DangerousCommandMatch` (descrizione e pattern/identificatore). Integrare il risultato nella regola Permission Gate senza spostare logica di matching nel parser adapter.

I matcher strutturali PowerShell devono:

- usare `commandName`, `elements`, valori e struttura AST, non regex sul testo intero;
- rispettare la semantica case-insensitive di nomi cmdlet e parametri PowerShell, indipendentemente dal flag configurabile per i pattern testuali;
- riconoscere soltanto alias esplicitamente inclusi in una tabella TypeScript: il parser non risolve alias e non conosce eventuali ridefinizioni runtime;
- non assumere che opzioni Unix, abbreviazioni di parametri o argomenti PowerShell siano equivalenti a quelli Bash;
- restituire il primo match secondo un ordine documentato e deterministico.

Come prima famiglia di matcher valutare comandi distruttivi PowerShell (per esempio rimozione ricorsiva con forza) e operazioni di disco/formattazione. Definire l’elenco concreto, alias coperti, condizioni e descrizioni in test prima di dichiarare la copertura. Questo elenco è distinto dai matcher e keyword Bash in `src/core/commands/dangerous.ts`.

L’attivazione dei matcher strutturali segue il valore risolto esistente `permissionGate.useBuiltinMatchers`. Non aggiungere un nuovo default che alteri la configurazione Bash. Se in futuro servisse attivare/disattivare i matcher PowerShell separatamente, trattarlo come modifica di configurazione separata.

## 7. Pattern, grant e case sensitivity

- `patterns`, `allowedPatterns` e `autoDenyPatterns` restano pattern su testo raw del comando e riusano matching esistente: substring con `includes`, oppure regex con `regex: true`.
- `permissionGate.caseInsensitive` si applica a questi pattern PowerShell come ai pattern Bash; non cambia le policy file.
- I pattern di configurazione attuali sono condivisi tra dialetti per compatibilità. Non reinterpretare pattern Bash come regole strutturali PowerShell.
- I grant sessione attuali sono salvati come pattern esatti nella config `memory`, senza dialetto. Prima dell’integrazione, evitare che un grant sessione per una stringa Bash autorizzi la stessa stringa PowerShell (o viceversa): aggiungere uno store sessione con chiave almeno `{ dialect, exactCommand }`, oppure documentare e approvare esplicitamente la semantica condivisa. I grant permanenti definiti dall’utente restano condivisi secondo il contratto esistente.

## 8. Errori e comportamento fail-safe

Il flusso deve distinguere:

- input del tool non valido (assenza di `command` stringa);
- errori di protocollo/operativi helper (`ok: false`, binario assente, timeout, output JSON invalido, protocollo incompatibile);
- parse error PowerShell (`ok: true` con `parseErrors` non vuoto e possibile AST parziale).

Mai interpretare `ok: true` come script valido o sicuro. Matcher testuali configurati devono poter lavorare anche se parsing strutturale fallisce. Se i matcher built-in sono abilitati e il parser non è disponibile/affidabile, il hook non deve restituire silenziosamente “safe”: seguire una policy fail-safe esplicita (rischio non analizzabile → prompt o block secondo configurazione/UI), con motivo chiaro e test dedicati.

Per parse error con AST parziale, preservare i match strutturali trovati, ma non dichiarare automaticamente sicuro il comando solo perché non è stato trovato un match nella parte analizzata. Definire nel codice/test se errore di parsing porta a prompt o block; nessuna eccezione deve diventare bypass del guardrail.

## 9. Eventi, prompt e grant

Per il percorso PowerShell:

- metadata dell’azione deve indicare origine/tool `powershell`;
- `guardrails:risk:detected`, `guardrails:action:blocked`, `guardrails:prompt:opened` e `guardrails:prompt:closed` devono riportare `toolName: "powershell"` e input ricevuto;
- UI mostra il comando originale PowerShell e la descrizione del matcher;
- scelte Allow/Deny/Stop mantengono il flusso Permission Gate esistente;
- non modificare le semantiche degli eventi Bash.

## 10. Test e criteri di accettazione

### Unit test TypeScript

- walker: comandi top-level e annidati, pipeline/scriptblock/subexpression, ordine elementi, node kind sconosciuti, dynamic/expression, nessuna visita duplicata;
- matcher: nomi cmdlet, parametri case-insensitive, combinazioni pericolose/non pericolose e soli alias esplicitamente supportati;
- matching testuale: literal, regex, `caseInsensitive` on/off per patterns, allowed e auto-deny;
- errori helper e parser: versione errata, JSON invalido, timeout/binario assente, parse error con AST parziale; nessun caso ritorna `safe` per default implicito;
- session grant scoping tra Bash e PowerShell.

### Hook test

- evento `powershell` con `{ command, timeout }` processa solo `command`;
- evento Bash continua sul percorso Bash senza regressioni;
- PowerShell non invoca parser Bash;
- i match producono prompt/warning/block ed eventi col tool name corretto;
- grant e precedenza dei pattern restano conformi alla sezione 4.

### Smoke test e pacchetto

- smoke test degli eseguibili disponibili per Windows x64 e Linux x64 usando request protocollo v1 e un comando PowerShell di esempio;
- verificare che il package distribuito includa l’artefatto corretto e permessi eseguibili Linux;
- errore chiaro su piattaforme senza artefatto; niente fallback silenzioso a Bash.

## 11. Binari e nota Native AOT

`bin/README.md` documenta gli artefatti Windows/Linux presenti e il protocollo, ma dichiara anche che le release attuali sono Native AOT. Questa è una proprietà degli artefatti esistenti, non un requisito architetturale dell’integrazione.

La decisione di progetto è evitare Native AOT per la strategia futura del helper (vedi `SPEC.md`). L’integrazione deve chiamare l’eseguibile come blackbox e non assumere dettagli AOT. Prima della distribuzione, chiarire se gli artefatti AOT già presenti sono solo fixture/prototipo o binari di release; non dichiarare “no Native AOT” finché il pacchetto effettivamente distribuito non usa artefatti coerenti con tale decisione.

## 12. Moduli probabilmente coinvolti

- `extensions/permission-gate/index.ts`: routing tool Bash/PowerShell e contesto eventi.
- `extensions/permission-gate/rules.ts`: collegamento tra dialect, checker e risultato regola.
- Nuovo adapter helper in `extensions/permission-gate/`: processo, protocollo, validazione e selezione binario.
- Nuovo tipo/walker DTO PowerShell in `src/core/` o adapter interno TS, mantenendo separato il matching Bash.
- Nuovo checker strutturale PowerShell in `src/core/commands/` o modulo core equivalente.
- `extensions/permission-gate/grants.ts`: grant sessione per dialetto.
- Test adiacenti ai moduli e test hook di `extensions/permission-gate/`.
- Documentazione pubblica/config solo se comandi supportati o comportamento utente cambiano.
