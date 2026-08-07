# 40. Estrategia de tests

El producto debe demostrar dos cosas distintas.

Primero:

> El email prueba la afirmación correcta.

Segundo:

> Midnight acepta una sola vez un claim firmado y válido.

No mezclar estas dos capas.

Un test de ZK Email no reemplaza un test de Compact.

Un test de Compact no prueba que el email era auténtico.

---

## 40.1 Pirámide de tests

```text
                    E2E
             UI → proof → claim
          → Midnight → resultado
                 /          \
        Integration       Demo tests
       /           \
ZK Email tests   Attestor tests
       \           /
        Compact unit tests
```

Prioridad:

1. contract unit tests;
2. attestor unit tests;
3. ZK Email fixture tests;
4. CLI integration;
5. browser end-to-end;
6. physical demo.

---

## 40.2 Matriz de tests de Compact

| ID | Caso | Input | Resultado esperado |
|---|---|---|---|
| C-01 | Claim válido | firma válida, campaign correcta, nullifier nuevo | acepta |
| C-02 | Firma alterada | cambia un byte del claim | rechaza |
| C-03 | Firma de otra key | signer no autorizado | rechaza |
| C-04 | Campaign incorrecta | otro `campaignId` | rechaza |
| C-05 | Blueprint incorrecto | otro `blueprintIdHash` | rechaza |
| C-06 | Claim type incorrecto | otro tipo | rechaza |
| C-07 | Replay | mismo nullifier dos veces | segunda llamada rechaza |
| C-08 | Nullifier alterado | claim y firma no coinciden | rechaza |
| C-09 | Subject binding incorrecto | otra identidad/contexto | rechaza |
| C-10 | Contrato pausado | claim válido | rechaza |
| C-11 | Attestor rotado | claim firmado con key vieja | rechaza |
| C-12 | State transition | claim válido | counter/receipt cambia exactamente una vez |

Regla:

Cada test negativo debe verificar el error exacto.

No aceptar:

```text
expect(() => call()).toThrow()
```

Preferir:

```text
expect(() => call()).toThrow("claim already used")
```

Esto mejora el diagnóstico.

---

## 40.3 Matriz de tests de ZK Email

| ID | Caso | Email | Resultado esperado |
|---|---|---|---|
| Z-01 | Email válido | fixture original | proof válido |
| Z-02 | Sender incorrecto | otro dominio | blueprint no valida |
| Z-03 | Texto no cancelado | email válido sin marker | no valida |
| Z-04 | Body alterado | cambia `cancelled` | DKIM/proof falla |
| Z-05 | Header alterado | cambia From/Subject firmado | falla |
| Z-06 | Email truncado | elimina sección requerida | falla |
| Z-07 | Template con espacios | cambios permitidos por regex | valida si el blueprint lo permite |
| Z-08 | Claim ID ausente | no existe unique field | falla |
| Z-09 | Multiple DKIM | firma correcta y firma adicional | comportamiento documentado |
| Z-10 | Email grande | supera límite definido | error controlado |
| Z-11 | Charset/encoding | quoted-printable o base64 | parseo correcto o rechazo explícito |
| Z-12 | Proof fixture | proof guardado | vuelve a verificar |

No cambiar el blueprint para hacer pasar un fixture roto sin registrar la decisión.

---

## 40.4 Matriz de tests del attestor

| ID | Caso | Resultado esperado |
|---|---|---|
| A-01 | Proof válido y blueprint permitido | firma claim |
| A-02 | Proof inválido | `PROOF_INVALID` |
| A-03 | Blueprint no permitido | `BLUEPRINT_NOT_ALLOWED` |
| A-04 | Public output faltante | `PUBLIC_OUTPUT_MISSING` |
| A-05 | Sender domain inesperado | `SENDER_NOT_ALLOWED` |
| A-06 | Claim marker inesperado | `CLAIM_NOT_SATISFIED` |
| A-07 | Campaign desconocida | `CAMPAIGN_NOT_ALLOWED` |
| A-08 | Subject binding mal formado | `INVALID_SUBJECT_BINDING` |
| A-09 | Request demasiado grande | `REQUEST_TOO_LARGE` |
| A-10 | Proof digest estable | mismo input produce mismo digest |
| A-11 | Nullifier contextual | misma evidencia + campaña distinta produce valor distinto |
| A-12 | Logs | no contienen raw email ni proof completo |
| A-13 | Signing key ausente | servicio falla cerrado |
| A-14 | Signature round trip | Compact fixture verifica la firma |
| A-15 | Timeout | error controlado, no claim parcial |

El attestor no debe firmar si una validación queda en estado desconocido.

Regla:

> `unknown` debe comportarse como `deny`.

---

## 40.5 Matriz de tests de integración

| ID | Flujo | Resultado |
|---|---|---|
| I-01 | `.eml` válido → proof → attestor → Compact | claim aprobado |
| I-02 | email alterado → proof | se detiene antes del attestor |
| I-03 | proof alterado → attestor | no firma |
| I-04 | claim alterado → Compact | no acepta |
| I-05 | replay completo | segunda redención falla |
| I-06 | reset demo | vuelve al estado esperado |
| I-07 | servicio reiniciado | config y key correctas |
| I-08 | proof pre-generado | flujo de backup funciona |
| I-09 | network offline | UI muestra error y no finge éxito |
| I-10 | attestor offline | UI ofrece retry, no bypass |

---

## 40.6 Tests de interfaz

Verificar:

- el archivo se procesa localmente;
- no se hace upload del `.eml` por accidente;
- el usuario ve qué se va a revelar;
- el botón queda desactivado durante proving;
- un error no borra el archivo sin explicación;
- el usuario puede cancelar antes de enviar a Midnight;
- el estado no dice `verified` antes de la confirmación real;
- el replay aparece como rechazo, no como crash;
- la UI funciona en resolución de proyector;
- el flujo puede operarse con teclado;
- no hay datos personales en console logs.

---

## 40.7 Tests de demo

Ejecutar el demo completo diez veces.

Registrar:

```text
run number
proof time
attestor time
Midnight time
result
manual intervention
error
```

Criterio mínimo:

- 9 de 10 ejecuciones completas;
- 10 de 10 ejecuciones del flujo de backup;
- cero raw emails en logs;
- cero estados falsos de éxito.

---

# 41. Threat model completo

El producto combina email, proving externo, un attestor y Midnight.

Cada capa tiene riesgos diferentes.

No decir:

> ZK resuelve todo.

ZK sólo prueba las restricciones que el circuito contiene.

---

## 41.1 Activos que protegemos

- contenido completo del email;
- identidad del destinatario;
- email address;
- booking data;
- precio;
- fechas;
- identificador de reserva;
- otros mensajes del inbox;
- private inputs del proof;
- signing key del attestor;
- claim nullifier preimage;
- wallet/private state;
- integridad del estado de redención.

---

## 41.2 Actores

### Usuario honesto

Posee un email auténtico.

Quiere probar un claim.

### Usuario malicioso

Puede:

- inventar un `.eml`;
- alterar el body;
- alterar public outputs;
- enviar un proof falso;
- repetir un claim;
- copiar un claim ajeno;
- modificar el frontend;
- llamar APIs directamente.

### Emisor de email

Puede mandar información incorrecta.

DKIM sólo demuestra que el dominio firmó el mensaje.

No demuestra verdad objetiva.

### Proveedor de email

Puede permitir acceso a la cuenta.

Puede rotar DKIM keys.

Puede cambiar el formato del mensaje.

### Attestor

Puede:

- firmar claims inválidos;
- censurar usuarios;
- registrar metadata;
- filtrar información;
- perder su key.

### DApp consumidora

Puede pedir más información de la necesaria.

Puede correlacionar proofs.

### Chain observer

Ve:

- contrato;
- circuito llamado;
- timing;
- state changes;
- valores públicos.

### Operador de proof infrastructure

Ve los datos que le enviamos.

Por eso preferimos proving local.

---

## 41.3 Riesgo: email falso

Ataque:

El usuario crea un texto que parece un email.

Mitigación:

ZK Email verifica DKIM y la estructura definida por el blueprint.

Límite:

Si el dominio emisor o su key están comprometidos, el proof puede validar un email malicioso firmado legítimamente.

---

## 41.4 Riesgo: el email dice una mentira

Ataque:

La aerolínea firma un email equivocado.

Mitigación:

Ninguna criptografía del producto puede convertir esa afirmación en verdad objetiva.

Claim correcto:

> `airline.example` firmó un mensaje que satisface el template de cancelación.

Claim incorrecto:

> El vuelo fue objetivamente cancelado.

El pitch debe usar el claim correcto.

---

## 41.5 Riesgo: DKIM key rotation

Problema:

Una key DKIM puede rotar.

Un proof puede necesitar resolver una key histórica.

Mitigación MVP:

- usar fixture con key resoluble;
- pinnear blueprint;
- registrar selector y dominio;
- guardar proof válido de backup;
- documentar fecha de captura.

Mitigación producción:

- DNSSEC;
- key archive;
- oracle de claves históricas;
- políticas de vigencia;
- múltiples fuentes.

---

## 41.6 Riesgo: múltiples firmas DKIM

Un email puede tener más de una firma.

El parser puede seleccionar una firma no esperada.

Mitigación:

- testear el fixture;
- registrar `d=` y `s=`;
- validar el dominio permitido;
- no aceptar cualquier firma válida;
- documentar qué firma usa el blueprint.

---

## 41.7 Riesgo: template drift

La aerolínea cambia:

```text
Your flight has been cancelled
```

por:

```text
We had to cancel your journey
```

El blueprint deja de funcionar.

Mitigación MVP:

- una sola plantilla;
- un solo fixture;
- regex acotada;
- fallback Luma.

Mitigación producto:

- blueprints versionados;
- template monitoring;
- test corpus;
- registry;
- issuer-specific adapters.

---

## 41.8 Riesgo: regex demasiado amplia

Una regex amplia puede aceptar:

```text
Your flight has not been cancelled
```

porque contiene `cancelled`.

Mitigación:

- regex por componentes;
- anchors;
- context tokens;
- fixtures negativos;
- no usar búsqueda booleana ingenua;
- revisar public outputs.

---

## 41.9 Riesgo: body cutoff incorrecto

Un cutoff corto puede omitir el texto importante.

Un cutoff amplio aumenta proving time.

Mitigación:

- medir posición del claim;
- usar mínimo suficiente;
- guardar decisión;
- testear email con contenido antes y después.

---

## 41.10 Riesgo: replay

Ataque:

El mismo email se usa varias veces.

Mitigación:

- unique claim field;
- context-bound nullifier;
- `usedNullifiers` en Compact;
- test de replay.

No usar únicamente `proofDigest` si el proof puede ser randomized.

---

## 41.11 Riesgo: front-running

Ataque:

Un observador copia un claim público antes de que confirme.

Mitigación:

- bind del claim al destinatario/contexto;
- incluir `subjectBindingHash`;
- incluir campaign/contract;
- incluir nonce;
- no aceptar una firma genérica transferible.

MVP:

Bind al identity secret de la dApp o a un recipient commitment.

---

## 41.12 Riesgo: proof copiado

Ataque:

Una persona obtiene el proof JSON de otra.

Mitigación:

- el attestor firma el subject binding;
- Compact verifica binding;
- prueba/attestation contextual;
- no almacenar proof público.

---

## 41.13 Riesgo: attestor malicioso

Este es el mayor trust boundary del MVP.

Ataque:

El attestor firma sin verificar.

Mitigación MVP:

- código open source;
- deterministic verification;
- auditable logs sin PII;
- public key fija;
- tests;
- clear disclosure.

Mitigación futura:

- threshold attestors;
- multiple independent verifiers;
- TEE;
- direct proof verification;
- recursive proof bridge;
- attestor staking/slashing si aplica.

No esconder este riesgo.

---

## 41.14 Riesgo: key del attestor comprometida

Mitigación:

- env var;
- key no committed;
- rotate circuit;
- pause;
- separate demo and production keys;
- no log;
- never expose to frontend.

Criterio de emergencia:

Si la key aparece en Git:

1. detener;
2. rotar;
3. invalidar;
4. limpiar history;
5. registrar incidente.

---

## 41.15 Riesgo: frontend modificado

El usuario controla el frontend.

No confiar en:

- booleano del browser;
- parsed output del browser;
- `verified = true`;
- claimed sender;
- claimed cancellation.

El attestor debe volver a verificar el proof.

Compact debe verificar la firma.

---

## 41.16 Riesgo: remote proving

Un prover remoto puede ver el email completo.

MVP recomendado:

```text
isLocal: true
```

Si local proving no funciona:

- usar proof pre-generado;
- explicar que fue generado localmente;
- no subir un email personal;
- usar fixture sintético;
- documentar el fallback.

---

## 41.17 Riesgo: logging

Prohibido loguear:

- raw `.eml`;
- email address;
- booking ID raw;
- proof completo;
- private inputs;
- attestor private key;
- Gmail tokens;
- wallet secrets.

Permitido:

- request ID aleatorio;
- blueprint slug;
- claim type;
- proof digest truncado;
- timings;
- success/error code.

---

## 41.18 Riesgo: correlación

Aunque el contenido quede privado, se puede correlacionar:

- timing;
- campaign;
- wallet;
- repeated subject binding;
- public nullifier;
- IP del attestor.

Mitigación futura:

- relayers;
- batching;
- one-time bindings;
- network privacy;
- delayed submission;
- coarser timestamps.

MVP:

Declararlo.

---

## 41.19 Riesgo: Gmail integration

OAuth con Gmail agrega:

- scopes;
- tokens;
- consent screen;
- domain approval;
- API quota;
- revisión;
- exfiltration risk.

Decisión:

No integrar Gmail en el MVP.

Usar `.eml`.

---

## 41.20 Riesgo: denial of service

Proof generation es costosa.

Un atacante puede enviar muchos proofs al attestor.

Mitigación:

- request size limit;
- concurrency limit;
- timeout;
- rate limit;
- blueprint allowlist;
- no expensive work antes de schema validation.

---

## 41.21 Qué no garantiza MailProof

MailProof no garantiza:

- que la afirmación del emisor sea verdadera;
- que el usuario siga controlando el inbox;
- que el email no haya sido reenviado;
- que el dominio sea confiable;
- que el recipient sea una persona única;
- que el attestor sea honesto;
- que no exista metadata;
- que todas las plantillas funcionen;
- que la aerolínea acepte el claim;
- que el proof sea verificable directamente por Compact.

La documentación debe incluir esta lista.

---

# 42. Modelo de errores

Los errores deben ser estables.

No mostrar stack traces al usuario.

No usar mensajes ambiguos.

## 42.1 Códigos de cliente

```text
FILE_REQUIRED
FILE_TOO_LARGE
FILE_TYPE_INVALID
EMAIL_PARSE_FAILED
EMAIL_NOT_COMPATIBLE
PROOF_GENERATION_FAILED
PROOF_VERIFICATION_FAILED
USER_CANCELLED
WALLET_NOT_CONNECTED
MIDNIGHT_SUBMISSION_FAILED
MIDNIGHT_CONFIRMATION_TIMEOUT
CLAIM_ALREADY_USED
```

## 42.2 Códigos del attestor

```text
INVALID_REQUEST
REQUEST_TOO_LARGE
BLUEPRINT_NOT_ALLOWED
CAMPAIGN_NOT_ALLOWED
PROOF_INVALID
PUBLIC_OUTPUT_MISSING
SENDER_NOT_ALLOWED
CLAIM_NOT_SATISFIED
INVALID_SUBJECT_BINDING
NULLIFIER_DERIVATION_FAILED
SIGNING_UNAVAILABLE
INTERNAL_ERROR
```

## 42.3 Errores Compact

```text
contract paused
invalid attestor signature
wrong campaign
wrong claim type
wrong blueprint
subject binding mismatch
claim already used
invalid claim encoding
```

## 42.4 Mensajes UX

Técnico:

```text
PROOF_INVALID
```

Humano:

> No pudimos verificar este email. El mensaje pudo cambiar o no coincide con el tipo de prueba.

Técnico:

```text
CLAIM_ALREADY_USED
```

Humano:

> Esta evidencia ya se usó para esta campaña.

---

# 43. Contratos de API

## 43.1 `POST /v1/attest`

Request conceptual:

```json
{
  "blueprintId": "owner/flight-cancellation@v1",
  "campaignId": "travel-insurance-demo-2026",
  "subjectBinding": "0x...",
  "publicOutputs": {},
  "proofData": {}
}
```

No incluir:

```json
{
  "rawEmail": "..."
}
```

Response:

```json
{
  "claim": {
    "version": 1,
    "claimType": "FLIGHT_CANCELLED",
    "blueprintIdHash": "0x...",
    "issuerDomainHash": "0x...",
    "campaignId": "0x...",
    "subjectBindingHash": "0x...",
    "claimNullifier": "0x...",
    "proofDigest": "0x..."
  },
  "signature": {
    "announcementX": "0x...",
    "announcementY": "0x...",
    "response": "0x..."
  },
  "attestorKeyId": "demo-v1"
}
```

## 43.2 `GET /health`

Response:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "blueprints": ["..."],
  "signerReady": true
}
```

No incluir key material.

## 43.3 Schema validation

Usar Zod o equivalente.

Configuración:

- reject unknown keys;
- max body size;
- fixed hash lengths;
- exact enum values;
- no implicit coercion para campos críticos.

---

# 44. Canonicalización y hashing

La firma debe ser estable.

No firmar un JSON crudo.

El orden de propiedades de JSON no debe importar.

## 44.1 Domain separation

Usar dominios distintos.

Ejemplo conceptual:

```text
MAILPROOF:CLAIM:V1
MAILPROOF:NULLIFIER:V1
MAILPROOF:SUBJECT:V1
MAILPROOF:BLUEPRINT:V1
MAILPROOF:PROOF-DIGEST:V1
```

## 44.2 Canonical claim vector

Ejemplo:

```text
[
  hash("MAILPROOF:CLAIM:V1"),
  version,
  claimType,
  blueprintIdHash,
  issuerDomainHash,
  campaignId,
  subjectBindingHash,
  claimNullifier,
  proofDigest
]
```

Usar la misma función en:

- attestor;
- fixture signer;
- tests;
- Compact verifier.

Crear golden vectors.

## 44.3 Golden vector

Guardar un fixture:

```json
{
  "input": {...},
  "canonicalFields": [...],
  "messageHash": "0x...",
  "signature": {...}
}
```

Testear en TypeScript y Compact.

Esto evita divergencias de encoding.

---

# 45. Observabilidad y privacidad

## 45.1 Métricas útiles

- proof generation duration;
- local proof verification duration;
- attestor verification duration;
- signing duration;
- Midnight proving/submission duration;
- confirmation duration;
- failure code;
- browser memory warning;
- demo run success rate.

## 45.2 Métricas prohibidas

No registrar:

- sender address completo;
- recipient address;
- booking ID;
- subject;
- body;
- raw proof;
- unique email claim ID.

## 45.3 Request ID

Generar un ID aleatorio.

No derivarlo del email.

## 45.4 Debug mode

Debug debe estar apagado para la demo.

Si se activa:

- usar fixture sintético;
- redacción obligatoria;
- aviso visible.

---

# 46. Performance

## 46.1 Medir, no asumir

Medir por separado:

```text
parse
validate
prove
verify locally
attest
Midnight prove
submit
confirm
```

## 46.2 UX durante proving

Mostrar etapas reales.

Ejemplo:

```text
1. Reading email locally
2. Checking template
3. Creating private proof
4. Verifying claim
5. Recording one-time receipt
```

No mostrar un spinner infinito.

## 46.3 Timeout budgets

Valores iniciales, no promesas:

```text
Email parse:       5 s
Local validation: 10 s
ZK proof:        180 s
Attestor:         30 s
Midnight submit: 120 s
Confirmation:    180 s
```

Ajustar después de medir.

## 46.4 Proof fixture

Guardar un proof de backup.

No usarlo como si fuera generado en vivo.

La UI debe tener un modo demo explícito:

```text
Use verified backup proof
```

Sólo activar si el live prover falla.

---

# 47. Fallback ladder

El agente debe seguir este orden.

No improvisar un fallback silencioso.

## 47.1 ZK Email blueprint

```text
Custom flight blueprint
        ↓ fails
Existing compatible blueprint
        ↓ fails
Official Luma example
        ↓ fails
Pre-generated proof fixture
```

## 47.2 Proving

```text
Browser local proving
        ↓ fails
Node local proving
        ↓ fails
Pre-generated local proof
```

No usar remote proving con datos reales sin aviso.

## 47.3 Midnight integration

```text
Browser + wallet
        ↓ fails
CLI + local devnet
        ↓ fails
Contract simulator/unit demo
```

Para submission, el frontend conectado es importante.

El CLI es fallback de demo, no meta final.

## 47.4 Attestor signature

```text
Official/built-in Schnorr support
        ↓ unavailable
Official ZK Loan polyfill
        ↓ fails
Temporary admin verification circuit
```

El último fallback debe quedar marcado como menor seguridad.

## 47.5 Network

```text
Preview
        ↓ unstable
Local devnet
```

Local devnet es aceptable para una demo técnica estable.

## 47.6 Physical output

```text
Servo / thermal printer
        ↓ fails
Large visual state change
        ↓ fails
CLI receipt
```

---

# 48. Go / no-go gates por tiempo

No usar horas absolutas si el evento cambia.

Usar tiempo desde inicio del build.

## H+1

Debe existir:

- repo;
- license;
- versions recorded;
- Compact scaffold compila.

Si no:

> pedir ayuda de tooling. No tocar ZK Email todavía.

## H+3

Debe existir:

- signed claim fixture;
- Compact acepta claim válido;
- Compact rechaza firma inválida;
- replay falla.

Si no:

> simplificar claim. Sacar receipts. Mantener signature + nullifier.

## H+5

Debe existir:

- `.eml` válido;
- blueprint elegido;
- local proof generado o fallback oficial funcionando.

Si no:

> cambiar inmediatamente a Luma/existing blueprint.

## H+7

Debe existir:

- proof verificado por attestor;
- claim firmado;
- Compact redemption por CLI.

Si no:

> usar proof fixture. No construir browser prover todavía.

## H+10

Debe existir:

- flujo web básico;
- wallet;
- upload;
- submit;
- result.

Si no:

> congelar diseño. Priorizar conexión real.

## H+13

Debe existir:

- negative demo;
- reset;
- README;
- tests verdes.

Si no:

> cortar hardware y features.

## Último bloque

Sólo:

- QA;
- video;
- deck;
- submission;
- backup.

No agregar features.

---

# 49. División de trabajo

Para tres personas:

## Persona A — Midnight / Compact

Responsable de:

- scaffold;
- contract;
- signature;
- nullifier;
- deploy;
- contract tests;
- wallet integration support.

No tocar UI antes del Gate 2.

## Persona B — ZK Email / Attestor

Responsable de:

- fixture;
- blueprint;
- proof generation;
- proof verification;
- attestor;
- canonical claim;
- tests.

No intentar direct verifier en Compact.

## Persona C — Product / Frontend / Demo

Responsable de:

- UX;
- local file handling;
- privacy panel;
- integration orchestration;
- demo props;
- README;
- deck;
- video.

No mockear `verified` sin conectar el core.

Para dos personas:

- A: Compact + integration.
- B: ZK Email + attestor + frontend.

Para una persona:

- Contract first.
- CLI end-to-end.
- Frontend last.

