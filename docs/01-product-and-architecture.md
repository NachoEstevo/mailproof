# 1. Decisión ejecutiva

## 1.1 Qué vamos a construir

Vamos a construir una dApp de Midnight que consume una prueba derivada de un email DKIM auténtico.

El email se procesa localmente.

ZK Email verifica:

- la firma DKIM;
- el dominio remitente;
- una afirmación concreta del contenido;
- un identificador estable para evitar doble uso.

MailProof transforma el resultado en un claim compatible con Midnight.

Compact verifica el claim.

Compact registra el uso del claim.

Compact rechaza el replay.

El frontend muestra:

- qué se probó;
- qué se reveló;
- qué quedó privado;
- qué estado cambió en Midnight.

## 1.2 Qué no vamos a construir

No vamos a construir una casilla de email.

No vamos a construir un proveedor de correo.

No vamos a construir Gmail privado.

No vamos a reemplazar ZK Email.

No vamos a implementar RSA, DKIM y regex desde cero en Compact.

No vamos a construir un sistema genérico para cualquier email durante el hackathon.

No vamos a soportar muchas plantillas.

No vamos a integrar una aerolínea real.

No vamos a pagar dinero real.

No vamos a construir un bridge trustless completo entre dos sistemas de prueba.

No vamos a afirmar que DKIM demuestra que un hecho es objetivamente verdadero.

## 1.3 Caso principal recomendado

El caso principal es:

# Proof of Flight Cancellation

El usuario tiene un email de cancelación de vuelo.

El email tiene datos privados.

Puede contener:

- nombre;
- dirección de email;
- número de reserva;
- vuelo;
- origen;
- destino;
- fecha;
- precio;
- otros pasajeros;
- condiciones comerciales.

La aseguradora sólo necesita saber:

> **Existe un email auténtico del dominio esperado que confirma una cancelación y corresponde a un claim no utilizado.**

MailProof genera esa prueba.

Midnight registra el claim.

La aplicación desbloquea una compensación simulada.

## 1.4 Fallback recomendado

Si el blueprint de cancelación no funciona rápido, usar:

# Proof of Event Registration

El usuario demuestra:

> **Recibí un email auténtico que confirma mi registro a un evento.**

Existe documentación oficial de ZK Email para un blueprint de Luma.

Este fallback reduce el riesgo.

El flujo técnico es el mismo.

Sólo cambia el claim.

## 1.5 La frase que debe recordar el jurado

> **El email deja de ser un documento que entregás. Se convierte en una prueba que controlás.**

---

# 2. El problema

Muchas organizaciones usan emails como evidencia.

Ejemplos:

- una aerolínea confirma una cancelación;
- una tienda envía un recibo;
- una universidad confirma una admisión;
- una empresa envía una oferta laboral;
- un organizador confirma un registro;
- un banco confirma la apertura de una cuenta;
- una plataforma confirma una reserva;
- un proveedor confirma una garantía;
- una empresa confirma una membresía.

Hoy el usuario suele demostrar estos hechos de una forma pobre.

Envía:

- una captura;
- un PDF;
- el email reenviado;
- el archivo completo;
- acceso a su inbox;
- un formulario con datos repetidos.

Esto crea cuatro problemas.

## 2.1 Exceso de datos

El verificador recibe más información de la necesaria.

## 2.2 Fraude sencillo

Una captura o un PDF puede ser modificado.

## 2.3 Fricción

El usuario debe exportar, enviar y explicar documentos.

## 2.4 Integración costosa

La aplicación debe integrar APIs de cada aerolínea, tienda o proveedor.

MailProof propone otra vía.

Usa la infraestructura que ya existe:

# Email con DKIM.

La entidad emisora sigue enviando un email normal.

No necesita conocer Midnight.

No necesita emitir una credencial blockchain.

No necesita instalar MailProof.

---

# 3. La propuesta

## 3.1 Definición

> **MailProof permite que una persona demuestre que posee un email auténtico de un dominio determinado y que ese email contiene una afirmación específica, sin revelar el email completo.**

## 3.2 Estructura de la propuesta

### Emisor

Envía un email normal firmado con DKIM.

### Usuario

Recibe el email.

Genera la prueba.

### MailProof

Verifica el proof de ZK Email.

Emite un claim para Midnight.

### DApp consumidora

Verifica el claim.

Ejecuta una acción.

### Midnight

Registra el estado verificable.

Evita el doble uso.

## 3.3 Qué integra cada parte

| Parte | ¿Integra MailProof? | Trabajo requerido |
|---|---:|---|
| Aerolínea o emisor | No | Envía su email normal con DKIM |
| Usuario | Usa la interfaz | Selecciona o carga el email |
| Aseguradora o dApp | Sí | Integra el claim y el contrato |
| Midnight | Sí | Verifica y registra el claim |
| ZK Email | Ya existe | Genera y verifica la prueba del email |

## 3.4 Por qué es extensible

MailProof no depende de una API propietaria de la aerolínea.

Depende de:

- un email accesible;
- una firma DKIM válida;
- una plantilla conocida;
- un claim bien definido.

Una nueva integración puede agregarse con un nuevo blueprint.

Ejemplos:

```text
FlightCancellationClaim
EventRegistrationClaim
PurchaseReceiptClaim
EmploymentOfferClaim
UniversityAdmissionClaim
WarrantyClaim
MembershipClaim
```

---

# 4. Qué prueba DKIM

DKIM permite verificar que un dominio autorizó un email.

DKIM también permite verificar que las partes firmadas no fueron modificadas.

DKIM no cifra el email.

DKIM no garantiza que el contenido sea verdadero.

DKIM no garantiza que la cuenta del remitente no fue comprometida.

DKIM no garantiza que el usuario actual sea el destinatario legítimo.

La afirmación correcta es:

> **Este dominio firmó un email que contiene esta afirmación.**

La afirmación incorrecta es:

> **El evento descrito es una verdad objetiva.**

Ejemplo correcto:

> `airline.example` firmó un email que contiene una confirmación de cancelación.

Ejemplo incorrecto:

> El vuelo fue cancelado en el mundo real sin ninguna otra condición.

Esta diferencia debe aparecer en el README y en el pitch.

---

# 5. Qué aporta ZK Email

ZK Email usa DKIM dentro de un circuito de zero-knowledge.

Puede verificar:

- la firma DKIM;
- el dominio;
- headers;
- partes del body;
- patrones de texto;
- campos seleccionados.

Puede revelar sólo algunos campos.

Puede mantener el resto del email privado.

El SDK actual permite:

- obtener un blueprint;
- validar un email;
- crear un prover;
- generar un proof;
- verificar el proof off-chain;
- verificar el proof on-chain en redes soportadas por ZK Email.

Para MailProof usaremos:

```text
@zk-email/sdk
```

Versión de referencia actual:

```text
2.0.11
```

El SDK tiene una opción de proving local.

Ejemplo conceptual:

```typescript
const prover = blueprint.createProver({ isLocal: true });
const proof = await prover.generateProof(eml);
const valid = await blueprint.verifyProof(proof);
```

El proving local es preferido.

El email no debe salir del navegador.

La verificación on-chain incluida por el SDK usa infraestructura EVM.

No es una verificación nativa de Midnight.

No debemos confundir ambas cosas.

---

# 6. Qué aporta Midnight

Midnight aporta:

- un contrato Compact;
- private state;
- witnesses;
- proofs del circuito Compact;
- estado público verificable;
- nullifiers o sets para evitar replay;
- un resultado compartido;
- una dApp conectada a wallet;
- una demostración clara de selective disclosure.

El hackathon evalúa de forma fuerte:

- contrato que compile;
- uso de private state;
- tests;
- frontend conectado;
- demo end-to-end;
- explicación clara.

MailProof debe usar Compact para una función central.

Compact no puede ser decorativo.

La función central será:

> **Aceptar sólo claims emitidos por el attestor autorizado y registrar cada claim una sola vez.**

---

# 7. La limitación técnica principal

ZK Email genera su propio proof.

Midnight genera proofs para contratos Compact.

Son sistemas diferentes.

La documentación pública revisada no muestra un camino oficial para verificar directamente un proof arbitrario de ZK Email dentro de Compact.

Por este motivo, el MVP debe usar un bridge de attestation.

Este bridge sigue el patrón del tutorial oficial ZK Loan de Midnight.

El patrón es:

1. un sistema externo verifica evidencia;
2. el sistema firma un claim;
3. Compact verifica la firma;
4. Compact evalúa reglas privadas o públicas;
5. Compact cambia el estado.

## 7.1 Arquitectura elegida

# ZK Email Proof → MailProof Attestor → Compact Claim

```text
Raw .eml
   │
   │ local only
   ▼
ZK Email prover
   │
   │ proof + minimal public outputs
   ▼
MailProof Attestor
   │
   │ verifies proof
   │ signs canonical claim
   ▼
Midnight DApp
   │
   │ Compact verifies attestor signature
   │ Compact checks nullifier
   ▼
Claim approved on Midnight
```

## 7.2 Trust boundary

El attestor puede mentir.

Si el attestor firma un claim falso, Compact lo aceptará.

El MVP no elimina esta confianza.

El MVP reduce otros tipos de confianza:

- el attestor no necesita recibir el email completo;
- la dApp no necesita recibir el email completo;
- el chain observer no recibe el email;
- el claim tiene un formato verificable;
- el uso queda registrado;
- el replay queda bloqueado.

## 7.3 Cómo explicar esta limitación

> **ZK Email verifica el correo. MailProof adapta esa prueba al modelo de Midnight mediante un attestor firmado. Compact verifica la firma y controla el estado del claim. El siguiente paso es reemplazar el attestor único por verificación directa o un conjunto descentralizado de attestors.**

## 7.4 Pregunta obligatoria para el mentor

Antes de implementar el bridge, preguntar:

> **¿Existe hoy un patrón soportado para verificar un proof externo de ZK Email directamente desde Compact?**

Si la respuesta es sí, revisar la arquitectura.

Si la respuesta es no, continuar con attestation bridge.

No perder más de 30 minutos en esta investigación.

---

# 8. Alternativas de arquitectura

## Opción A — Attestor firmado

**Estado:** recomendada.

Ventajas:

- viable;
- usa un patrón oficial;
- Compact sigue siendo central;
- permite un MVP completo;
- fácil de testear.

Desventajas:

- introduce confianza en el attestor;
- no es un bridge trustless;
- requiere proteger una key.

## Opción B — Verificación directa del proof externo

**Estado:** sólo si el mentor confirma soporte.

Ventajas:

- menos confianza;
- tesis más fuerte;
- integración criptográfica profunda.

Desventajas:

- alto riesgo;
- no documentada en las fuentes revisadas;
- puede requerir verifier específico;
- puede consumir todo el hackathon.

## Opción C — Implementar DKIM/RSA en Compact

**Estado:** no hacer.

Razones:

- RSA es costoso;
- canonicalización DKIM es compleja;
- regex de emails es compleja;
- manejo de claves DKIM es complejo;
- el tiempo no alcanza;
- ZK Email ya resuelve esta capa.

## Opción D — Guardar un hash del proof

**Estado:** inválida.

Un hash no verifica el proof.

No usar esta arquitectura.

## Opción E — Backend dice `true`

**Estado:** demasiado débil.

Si el backend sólo escribe `verified=true`, Midnight es decorativo.

Como mínimo, Compact debe:

- verificar una firma;
- validar el claim;
- validar el contexto;
- impedir replay;
- cambiar un estado.

---

# 9. Caso de usuario completo

## 9.1 Situación

Ignacio tiene un seguro de viaje.

La aerolínea cancela su vuelo.

La aerolínea envía un email normal.

La aerolínea no integra MailProof.

## 9.2 Acción

Ignacio abre la dApp del seguro.

Selecciona:

> Verificar cancelación

Conecta una wallet de Midnight para el hackathon.

Carga el archivo `.eml`.

## 9.3 Procesamiento privado

El navegador lee el email.

El navegador no sube el email al backend.

ZK Email genera un proof local.

El proof demuestra:

- DKIM válido;
- dominio esperado;
- contenido de cancelación;
- claim identificable.

## 9.4 Bridge

La dApp envía al attestor:

- proof;
- outputs mínimos;
- blueprint;
- context;
- wallet binding.

No envía el email completo.

El attestor verifica el proof.

El attestor firma un claim.

## 9.5 Midnight

El usuario envía el claim a Compact.

Compact verifica:

- firma del attestor;
- claim type;
- campaign;
- wallet binding;
- nullifier no usado.

Compact marca el claim como usado.

Compact incrementa el contador.

Compact emite el estado necesario.

## 9.6 Resultado

La dApp muestra:

```text
FLIGHT CANCELLATION VERIFIED
CLAIM APPROVED
```

La dApp muestra qué quedó privado.

La dApp puede imprimir un voucher.

## 9.7 Ataque

Ignacio intenta usar el mismo email otra vez.

El proof puede ser válido.

La firma puede ser válida.

Pero el nullifier ya existe.

Compact rechaza el segundo claim.

## 9.8 Segundo ataque

Ignacio modifica el email.

Cambia:

```text
Delayed
```

por:

```text
Cancelled
```

La firma DKIM deja de ser válida.

ZK Email rechaza el email.

El claim no llega a Midnight.

---

# 10. Claims de MailProof

Un claim es una afirmación normalizada.

Ejemplo:

```text
Claim type:
FLIGHT_CANCELLED

Issuer:
airline.example

Campaign:
insurance-demo-2026

Subject:
wallet-bound user

One-time identifier:
context nullifier
```

El claim no debe contener strings largos dentro de Compact.

Los strings deben convertirse a valores fijos.

Usar:

- hashes;
- enums;
- `Bytes<32>`;
- `Uint<N>`;
- vectores de tamaño fijo.

---

# 11. ClaimAttestationV1

Definir una estructura canónica.

No cambiar la estructura durante el hackathon sin registrar la decisión.

Estructura conceptual:

```text
ClaimAttestationV1
────────────────────────────────
version
claimType
blueprintIdHash
issuerDomainHash
campaignId
subjectBindingHash
claimNullifier
proofDigest
```

## 11.1 Campos

### version

Versión del formato.

Valor:

```text
1
```

### claimType

Enum.

Ejemplo:

```text
1 = FLIGHT_CANCELLED
2 = EVENT_REGISTERED
```

Implementar sólo uno.

### blueprintIdHash

Hash del slug y versión del blueprint.

Ejemplo:

```text
H("team/FlightCancellation@v1")
```

### issuerDomainHash

Hash del dominio DKIM aceptado.

No usar el header `From` como única fuente.

Usar el dominio DKIM configurado en el blueprint.

### campaignId

Identifica el contexto de uso.

Ejemplo:

```text
H("mailproof:hackba:flight-claim:v1")
```

Esto evita reutilizar un proof en otra aplicación.

### subjectBindingHash

Bind al usuario o wallet.

En el MVP puede ser:

```text
H(walletPublicIdentity || challengeNonce)
```

La fuerza de este binding depende del bridge.

No afirmar que prueba propiedad del inbox si no existe un challenge de inbox.

### claimNullifier

Identificador de un solo uso.

Debe ser estable para el mismo claim.

Debe cambiar entre campaigns.

Ejemplo conceptual:

```text
H(
  "mailproof:nullifier:v1",
  blueprintIdHash,
  uniqueEmailClaimHash,
  campaignId
)
```

### proofDigest

Hash del proof y outputs verificados.

Sirve para auditoría.

No reemplaza la verificación.

## 11.2 Canonicalización

Todos los componentes deben tener orden fijo.

No firmar JSON sin canonicalización.

Preferir un vector fijo de fields o hashes.

Ejemplo conceptual:

```text
message = [
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

El attestor firma el hash de este mensaje.

Compact reconstruye el mismo hash.

---

# 12. Nullifier

El nullifier evita doble claim.

## 12.1 Requisito

El mismo email no debe poder crear dos compensaciones en la misma campaign.

## 12.2 Identificador estable

Usar un campo único y firmado por DKIM.

Opciones:

1. booking reference;
2. claim code;
3. Message-ID;
4. order ID;
5. registration ID;
6. una combinación estable.

No usar un valor que el usuario pueda modificar.

No usar un header que no esté cubierto por DKIM.

## 12.3 Privacidad

El identificador crudo no debe escribirse on-chain.

El attestor puede recibir el campo revelado por el proof.

El attestor deriva el nullifier.

La chain recibe sólo el nullifier.

## 12.4 Riesgo

Si el mismo nullifier se usa en varias apps, permite correlación.

Mitigación:

```text
nullifier = H(uniqueClaim, campaignId)
```

Cada campaign produce otro nullifier.

## 12.5 Fallback

Si no existe un identificador estable, no prometer replay protection completo.

Cambiar al blueprint de evento con un registration ID.

No inventar unicidad.

---

# 13. Binding al usuario

Un proof de un `.eml` demuestra posesión del archivo.

No demuestra automáticamente control actual del inbox.

Una persona puede reenviar el archivo.

Una persona puede robar el archivo.

## 13.1 Nivel MVP

Bind del attestation a la wallet que solicita el claim.

Flujo:

1. dApp crea un challenge;
2. wallet acepta el challenge;
3. attestor verifica el proof;
4. attestor firma el claim con `subjectBindingHash`;
5. sólo esa wallet puede usar el claim.

Esto evita front-running simple.

No evita que alguien con el `.eml` genere su propio claim.

## 13.2 Nivel producción

Agregar proof of inbox control.

Opciones:

- email challenge fresco;
- external input dentro del blueprint;
- matching privado del destinatario;
- dos proofs que comparten un recipient commitment;
- passkey o account binding.

## 13.3 Lenguaje correcto

MVP:

> **Proof of possession of an authenticated email claim.**

No decir:

> **Proof of permanent ownership of the inbox.**

Para un claim de ownership, implementar challenge fresco.

---

# 14. Privacidad

## 14.1 Datos que permanecen locales

- raw `.eml`;
- cuerpo completo;
- attachments;
- nombre;
- booking details no seleccionados;
- otros pasajeros;
- historial del inbox;
- otros emails.

## 14.2 Datos que puede ver ZK Email local prover

El prover local procesa el email.

No enviar el raw email a un remote prover en el path principal.

## 14.3 Datos que ve el attestor

Sólo:

- proof;
- public outputs;
- blueprint;
- context;
- subject binding;
- campos mínimos necesarios.

## 14.4 Datos que ve Midnight

- contract address;
- circuit llamado;
- campaign;
- nullifier;
- claim result;
- timing;
- cualquier field divulgado.

## 14.5 Datos que ve la dApp

- proof status;
- claim status;
- campos que la UX decide revelar.

## 14.6 Panel obligatorio en UI

Mostrar:

```text
REVEALED
✓ Claim type
✓ Trusted sender domain
✓ Claim valid
✓ Claim not used before

PRIVATE
• Full email
• Recipient address
• Booking details
• Price
• Other passengers
• Inbox history
```

Ajustar la lista a la implementación real.

No afirmar privacidad de un campo que se envió al attestor.

---

# 15. Arquitectura de componentes

```text
┌──────────────────────────────────────────────┐
│ USER BROWSER                                 │
│                                              │
│  .eml file                                   │
│     │                                        │
│     ▼                                        │
│  ZK Email SDK                                │
│     │                                        │
│     ├── local validate                       │
│     ├── local prove                          │
│     └── proof + public outputs               │
│                                              │
│  Midnight wallet / DApp Connector            │
└───────────────┬──────────────────────────────┘
                │
                │ proof package
                ▼
┌──────────────────────────────────────────────┐
│ MAILPROOF ATTESTOR                           │
│                                              │
│  allowlisted blueprint                       │
│  ZK Email off-chain verifier                 │
│  output validation                           │
│  nullifier derivation                        │
│  claim canonicalization                      │
│  Midnight-native signature                   │
└───────────────┬──────────────────────────────┘
                │
                │ signed ClaimAttestationV1
                ▼
┌──────────────────────────────────────────────┐
│ MIDNIGHT DAPP                                │
│                                              │
│  Compact contract                            │
│     ├── verify attestor signature            │
│     ├── verify campaign                      │
│     ├── verify subject binding               │
│     ├── reject used nullifier                │
│     └── record claim                         │
│                                              │
│  Public state / receipt                      │
└──────────────────────────────────────────────┘
```

---

# 16. Estado del contrato Compact

Mantener el estado mínimo.

## 16.1 Ledger recomendado

Conceptual:

```text
attestorPublicKey
campaignId
usedNullifiers
approvedClaimCount
claimReceipts
paused
```

## 16.2 attestorPublicKey

Key autorizada para firmar claims.

Registrar en constructor.

## 16.3 campaignId

Contexto fijo del contrato.

Evita uso cross-app.

## 16.4 usedNullifiers

Set de nullifiers.

Si el nullifier existe, rechazar.

## 16.5 approvedClaimCount

Counter para la demo.

## 16.6 claimReceipts

Opcional.

Guardar hash del receipt.

No guardar email.

## 16.7 paused

Opcional.

Permite detener claims si el attestor se compromete.

No implementar si pone en riesgo el core.

---

# 17. Circuits Compact

## 17.1 constructor

Responsabilidades:

- registrar public key;
- registrar campaign;
- iniciar estado.

## 17.2 redeemClaim

Inputs conceptuales:

```text
ClaimAttestationV1
AttestorSignature
subjectSecret or subject binding witness
```

Checks:

1. version soportada;
2. claim type correcto;
3. blueprint permitido;
4. issuer permitido;
5. campaign correcto;
6. subject binding correcto;
7. firma válida;
8. nullifier no usado;
9. contract no pausado.

Effects:

1. insertar nullifier;
2. incrementar counter;
3. registrar receipt hash;
4. retornar resultado o permitir que la UI lea estado.

## 17.3 revokeAttestor o rotateAttestor

P1.

Sólo si el admin path es seguro.

## 17.4 pause

P1.

No priorizar antes de tener redeem estable.

---

# 18. Firma del attestor

Usar una firma compatible con Compact.

El tutorial oficial ZK Loan usa una attestation API con Schnorr sobre Jubjub.

Seguir ese patrón.

## 18.1 Orden de preferencia

1. usar una función nativa soportada por el toolchain actual;
2. usar el patrón oficial del tutorial ZK Loan;
3. adaptar el polyfill oficial con atribución.

## 18.2 No hacer

No inventar una firma.

No usar ECDSA secp256k1 si Compact no la verifica.

No verificar una firma en TypeScript y omitir el check en Compact.

## 18.3 Test mínimo

- firma correcta pasa;
- firma incorrecta falla;
- modificar un field después de firmar falla;
- cambiar campaign falla;
- cambiar nullifier falla;
- usar otra public key falla.

---

# 19. MailProof Attestor

## 19.1 Rol

El attestor verifica el proof ZK Email.

El attestor no recibe el raw email.

El attestor emite un claim firmado.

## 19.2 Endpoint

Recomendado:

```text
POST /api/attest
```

## 19.3 Request

Conceptual:

```json
{
  "blueprintSlug": "team/FlightCancellation@v1",
  "proofData": {},
  "publicOutputs": {},
  "subjectBinding": "0x...",
  "campaignId": "0x...",
  "challengeNonce": "0x..."
}
```

## 19.4 Response

Conceptual:

```json
{
  "claim": {
    "version": 1,
    "claimType": 1,
    "blueprintIdHash": "0x...",
    "issuerDomainHash": "0x...",
    "campaignId": "0x...",
    "subjectBindingHash": "0x...",
    "claimNullifier": "0x...",
    "proofDigest": "0x..."
  },
  "signature": {
    "announcement": "...",
    "response": "..."
  },
  "attestorPublicKey": "..."
}
```

## 19.5 Validaciones obligatorias

1. schema exacto;
2. payload size;
3. blueprint allowlist;
4. blueprint version fija;
5. proof verificado;
6. public outputs esperados;
7. sender domain esperado;
8. claim phrase esperada;
9. identifier único presente;
10. campaign permitido;
11. subject binding válido;
12. challenge no expirado;
13. rate limit;
14. no logging de PII.

## 19.6 Fail closed

Si hay duda, rechazar.

No devolver una firma parcial.

No firmar con campos default.

## 19.7 Logs

Permitidos:

```text
requestId
blueprintIdHash
proofDigest
claimNullifier
result
duration
errorCode
```

Prohibidos:

```text
raw email
recipient email
booking code
subject completo
body
proof witness
private key
```

## 19.8 Key management

Hackathon:

- key en variable de entorno;
- servicio local;
- no commit;
- backup en un equipo del team.

Producción:

- HSM;
- rotation;
- threshold signing;
- multi-attestor;
- audit.

---

# 20. Blueprint de ZK Email

## 20.1 Objetivo

Probar:

> Un email con DKIM válido del dominio esperado contiene una confirmación de cancelación.

## 20.2 Archivo de prueba

Necesitamos un `.eml` real.

Debe tener:

- DKIM-Signature;
- body completo;
- sender domain;
- template estable;
- identificador único;
- contenido no sensible o sintético.

No usar un email personal en el repo.

## 20.3 Emisor de demo

Opciones:

1. dominio controlado por el equipo;
2. email de un evento con blueprint existente;
3. email sintético enviado por un proveedor con DKIM;
4. sample oficial de ZK Email.

Orden recomendado:

- intentar dominio controlado;
- si demora, usar Proof of Luma.

## 20.4 Inspección del `.eml`

Registrar:

```text
From
To
Subject
Date
Message-ID
DKIM d=
DKIM s=
DKIM h=
body format
Content-Transfer-Encoding
```

Confirmar que los campos usados están cubiertos por DKIM.

## 20.5 Configuración de blueprint

Campos:

```text
Pattern name:
Flight Cancellation Proof

Sender domain:
actual d= value

Header max length:
minimum safe multiple of 64

Body cutoff:
minimum safe value

Skip body hash:
NO if claim is in body
YES only if all claim data is in signed headers
```

## 20.6 Campos a extraer

P0:

```text
cancellationMarker
uniqueClaimId
```

Opcional:

```text
flightNumber
recipient
date
```

Sólo hacer públicos los campos necesarios para el attestor.

## 20.7 Regex

La regex debe ser específica.

No usar una regex amplia como:

```text
cancelled
```

Usar contexto.

Ejemplo conceptual:

```text
Your flight [FLIGHT] has been cancelled
```

No asumir HTML limpio.

Inspeccionar text/plain y text/html.

## 20.8 Multiple DKIM signatures

Un email puede tener varias firmas.

Elegir la firma más cercana al remitente real.

Usar el `d=` correcto.

No usar automáticamente la primera firma.

## 20.9 Versionado

El blueprint es un contrato de datos.

Pin exacto:

```text
owner/slug@version
```

No usar `latest`.

Guardar en:

```text
config/blueprints.json
```

---

# 21. Flujo técnico completo

## 21.1 Inicio

La dApp crea un request ID.

La dApp crea un challenge nonce.

La dApp obtiene el binding de wallet.

## 21.2 Carga local

El usuario selecciona `.eml`.

La UI lee el archivo con `File.text()`.

No hacer upload.

## 21.3 Validación rápida

Ejecutar:

```text
blueprint.validateEmail(eml)
```

Si falla, mostrar error.

No iniciar proving.

## 21.4 Proof generation

Crear prover local.

Generar proof.

Medir tiempo.

Mostrar progreso.

## 21.5 Verificación local

Ejecutar:

```text
blueprint.verifyProof(proof)
```

Esto es defensa adicional.

El attestor debe verificar otra vez.

## 21.6 Attestation

Enviar proof y outputs.

El attestor verifica.

El attestor genera claim.

El attestor firma.

## 21.7 Midnight transaction

Guardar claim en private state o pasar como input privado.

Llamar `redeemClaim`.

El proof server de Midnight genera el proof Compact.

La transacción cambia estado.

## 21.8 Confirmación

Esperar confirmación.

Leer ledger.

Mostrar result.

## 21.9 Replay demo

Enviar el mismo claim otra vez.

Compact debe fallar.

---

# 22. Wallet y UX

## 22.1 Hackathon

Usar wallet o provider recomendado por el scaffold.

El usuario deberá conectar una wallet.

No intentar embedded wallet.

## 22.2 Producto futuro

La wallet puede ser invisible.

Puede usar:

- passkey;
- embedded wallet;
- session key;
- sponsor de DUST;
- account abstraction futura.

## 22.3 Mensaje UX

No decir:

> Connect wallet to submit a ZK transaction.

Decir:

> Verify claim

El detalle técnico puede aparecer en un panel.

---

# 23. Repositorio recomendado

```text
mailproof/
├── LICENSE
├── README.md
├── package.json
├── .nvmrc
├── .gitignore
├── docker-compose.yml
│
├── contracts/
│   ├── mailproof.compact
│   ├── schnorr.compact
│   └── tests/
│       ├── redeem-valid.test.ts
│       ├── redeem-replay.test.ts
│       ├── redeem-signature.test.ts
│       └── redeem-context.test.ts
│
├── managed/
│   └── ...
│
├── apps/
│   └── web/
│       ├── app/
│       ├── components/
│       ├── lib/
│       │   ├── zk-email.ts
│       │   ├── midnight.ts
│       │   ├── claim.ts
│       │   └── privacy.ts
│       └── public/
│
├── services/
│   └── attestor/
│       ├── src/
│       │   ├── server.ts
│       │   ├── verify-proof.ts
│       │   ├── claim-schema.ts
│       │   ├── nullifier.ts
│       │   ├── sign.ts
│       │   └── logging.ts
│       └── tests/
│
├── packages/
│   └── shared/
│       ├── claim-schema.ts
│       ├── hashes.ts
│       ├── errors.ts
│       └── constants.ts
│
├── config/
│   ├── blueprints.json
│   ├── networks.ts
│   └── claims.ts
│
├── fixtures/
│   ├── proofs/
│   ├── claims/
│   └── README.md
│
├── scripts/
│   ├── prove-email.ts
│   ├── verify-email.ts
│   ├── sign-claim.ts
│   ├── redeem-claim.ts
│   └── reset-demo.ts
│
└── docs/
    ├── BUILD_LOG.md
    ├── DECISIONS.md
    ├── KNOWN_LIMITATIONS.md
    ├── ARCHITECTURE.md
    ├── PRIVACY_MODEL.md
    ├── THREAT_MODEL.md
    ├── DEMO_RUNBOOK.md
    └── PITCH.md
```

No crear todos los archivos de inmediato.

Crear cada directorio cuando el gate lo necesite.

