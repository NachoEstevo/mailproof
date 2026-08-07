# 50. Demo runbook

La demo debe durar entre tres y cuatro minutos.

Debe tener una historia.

No debe parecer una secuencia de dashboards.

La transformación es:

```text
EMAIL PRIVADO
      ↓
CLAIM VERIFICABLE
      ↓
ACCIÓN MIDNIGHT
```

---

## 50.1 Escena física

Elementos:

- una laptop del usuario;
- una pantalla grande;
- una segunda ventana de la aseguradora;
- un email de cancelación con datos privados visibles;
- un voucher impreso o visual;
- opcional: impresora térmica;
- opcional: caja/locker que se abre.

No usar información personal real.

Usar un fixture sintético que parezca real.

---

## 50.2 Pantallas

### Pantalla A — Inbox evidence

Muestra:

```text
From: demo-airline.example
To: ana.demo@example.test
Subject: Your flight has been cancelled

Booking: MP-8F2A19
Flight: MP401
Price: USD 487
Passenger: Ana Demo
```

Marcar visualmente:

```text
PRIVATE
```

### Pantalla B — Claim builder

Muestra:

```text
Claim requested:
Flight cancellation

Will reveal:
✓ Trusted sender domain
✓ Cancellation condition
✓ One-time claim eligibility

Will keep private:
• passenger email
• booking details
• price
• full message
```

### Pantalla C — Insurance dApp

Muestra:

```text
Waiting for private proof
```

Después:

```text
Claim verified
Compensation unlocked
```

### Pantalla D — Technical proof panel

Pequeño.

Muestra:

```text
ZK Email proof       verified
MailProof attestor   verified
Compact transaction  confirmed
Nullifier            consumed
```

No mostrar hashes enormes como elemento principal.

---

## 50.3 Guion exacto

### 0:00–0:25 — Problema

Decir:

> Cuando una aerolínea cancela un vuelo, ya existe una evidencia digital: el email.
>
> Pero para reclamar, normalmente tenemos que reenviar el mensaje completo o subir una captura.
>
> Eso entrega nombre, email, reserva, precio y más información de la necesaria.

Mostrar el email.

### 0:25–0:45 — Propuesta

Decir:

> MailProof convierte ese email en una prueba privada.
>
> La aerolínea no cambia nada.
>
> Sigue enviando un email normal.
>
> La aplicación que necesita la evidencia recibe sólo el claim.

### 0:45–1:30 — Proof

Arrastrar `.eml`.

Mostrar:

```text
Processed locally
```

Decir:

> El email no se sube.
>
> ZK Email verifica la firma DKIM y el template.
>
> El proof demuestra que un dominio autorizado firmó un mensaje de cancelación.

Dejar correr proving.

Durante la espera, mostrar “revealed/private”.

### 1:30–2:10 — Midnight

Decir:

> Ahora llevamos ese claim a Midnight.
>
> Compact verifica la attestation, la campaña y que esta evidencia no se haya usado antes.

Enviar.

Mostrar cambio de estado.

Imprimir voucher o abrir locker.

Decir:

> La aseguradora obtiene la prueba que necesita.
>
> Nunca recibió el email.

### 2:10–2:40 — Ataque 1

Decir:

> Ahora voy a cambiar una palabra del email.

Cambiar:

```text
delayed
```

por:

```text
cancelled
```

Intentar.

Resultado:

```text
Proof rejected
Email integrity failed
```

Decir:

> Una captura puede editarse.
>
> La firma del email no.

### 2:40–3:05 — Ataque 2

Usar el email original otra vez.

Resultado:

```text
Claim already used
```

Decir:

> El mismo email tampoco puede cobrar dos veces.
>
> Compact consume un nullifier contextual.

### 3:05–3:30 — Visión

Decir:

> Hoy mostramos una cancelación de vuelo.
>
> Mañana el mismo patrón puede probar una compra, una invitación, una reserva, una membresía o una notificación oficial.
>
> El emisor no necesita conocer Midnight.
>
> MailProof trae evidencia del mundo real a aplicaciones privadas.

### 3:30–3:45 — Cierre

> **Turn emails into private proofs.**
>
> **Your inbox already knows. MailProof lets you prove it.**

---

## 50.4 Demo fallback

Si browser proving tarda:

1. iniciar live proof;
2. explicar proceso;
3. después de umbral definido, usar backup;
4. decir claramente:
   > Para proteger el tiempo de la demo, usamos un proof generado localmente con este mismo fixture.
5. continuar con attestor y Midnight en vivo.

No fingir que el proof se generó durante la demo.

---

## 50.5 Demo reset

Crear:

```bash
npm run demo:reset
```

Debe:

- seleccionar campaign nueva; o
- desplegar contrato nuevo; o
- usar fixture/nullifier distinto;
- limpiar UI local;
- confirmar attestor health;
- confirmar wallet;
- confirmar proof fixture.

No borrar state manualmente durante el pitch.

---

# 51. Pitch

## 51.1 Diez segundos

> **MailProof convierte emails auténticos en pruebas privadas. Una app puede verificar que recibiste una cancelación, una compra o una invitación sin recibir tu email completo.**

---

## 51.2 Treinta segundos

> Las empresas ya emiten evidencia digital todos los días por email.
>
> Pero cuando queremos usar esa evidencia, reenviamos el mensaje completo o subimos una captura.
>
> MailProof usa ZK Email para probar una afirmación del mensaje y Midnight para consumir ese claim de forma verificable y única.
>
> El emisor no integra nada.
>
> La aplicación aprende el hecho que necesita, no todo tu inbox.

---

## 51.3 Sesenta segundos

> Una aerolínea cancela tu vuelo y te manda un email.
>
> Para reclamar al seguro, hoy normalmente entregás el mensaje completo. Eso expone tu dirección, reserva, precio y datos que el seguro no necesita.
>
> MailProof transforma ese email en una prueba privada.
>
> ZK Email verifica que el dominio de la aerolínea firmó un mensaje que cumple el template de cancelación.
>
> Después, Compact verifica un claim firmado, lo vincula a la campaña y evita que la misma evidencia se use dos veces.
>
> La aerolínea no necesita integrar Midnight.
>
> La aseguradora recibe sólo:
>
> **cancelación verificada.**
>
> No recibe el email.
>
> **Turn emails into private proofs.**

---

## 51.4 Noventa segundos

> El mundo ya tiene una infraestructura para emitir evidencia digital.
>
> Se llama email.
>
> Aerolíneas, bancos, marketplaces, universidades y eventos envían mensajes firmados con DKIM.
>
> Sin embargo, para usar esa evidencia seguimos reenviando emails completos, subiendo capturas y exponiendo datos que el verificador no necesita.
>
> MailProof cambia el formato de confianza.
>
> En lugar de entregar el documento, el usuario demuestra una afirmación.
>
> En nuestra demo, una persona prueba que recibió un email auténtico de cancelación de vuelo.
>
> ZK Email verifica el sender y el contenido necesario sin revelar el mensaje completo.
>
> MailProof convierte ese proof en un claim compatible con Midnight.
>
> Compact verifica el attestor, vincula el claim a la campaña y consume un nullifier para evitar doble uso.
>
> La aerolínea no cambia su sistema.
>
> La aseguradora recibe solamente:
>
> **flight cancellation verified.**
>
> Hoy es un seguro.
>
> Mañana puede ser una compra, una invitación, una reserva o una membresía.
>
> **Your inbox already knows. MailProof lets you prove it.**

---

## 51.5 Pitch de tres minutos

Estructura:

```text
0:00 problema
0:30 idea
0:50 arquitectura humana
1:15 demo
2:30 ataque/replay
2:50 visión/cierre
```

No dedicar más de veinte segundos a DKIM.

Definición simple:

> DKIM es la firma que ya acompaña muchos emails.

No explicar RSA salvo pregunta.

---

# 52. Preguntas del jurado

## “¿La aerolínea tiene que integrar MailProof?”

> No. La aerolínea sigue enviando un email normal firmado con DKIM. La entidad que consume el claim integra MailProof.

## “¿Por qué no reenviar el email?”

> Porque el verificador recibe datos extra y debe almacenar el documento. MailProof revela sólo la afirmación necesaria.

## “¿Por qué no subir una captura?”

> Una captura no prueba autenticidad. Un email DKIM puede probar que un dominio firmó el mensaje.

## “¿DKIM demuestra que el vuelo fue cancelado?”

> Demuestra que el dominio firmó un mensaje que satisface el claim. No convierte la afirmación del emisor en verdad objetiva.

## “¿Por qué Midnight?”

> Midnight administra el estado verificable del claim. Compact valida la attestation, la vincula a una campaña y evita replay sin publicar el email.

## “¿Por qué no verificar ZK Email directamente?”

> No encontramos una ruta documentada y compatible para verificar ese proof externo directamente dentro de Compact en este plazo. Usamos un attestor firmado, siguiendo el patrón de attestation que Midnight documenta. Es un trust boundary explícito.

## “Entonces, ¿hay que confiar en el attestor?”

> Sí, en el MVP. El proof de email se verifica de forma determinística y el código es auditable, pero el signer sigue siendo una entidad confiable. El roadmap es threshold attestation o verificación directa.

## “¿El email se sube a su servidor?”

> No en el flujo recomendado. Se procesa y prueba localmente. El attestor recibe proof y outputs públicos.

## “¿Cómo evitan cobrar dos veces?”

> Compact registra un nullifier contextual derivado de un identificador único del email y la campaña.

## “¿Alguien puede copiar mi proof?”

> El claim se vincula a un subject/context. Además se consume una sola vez.

## “¿Qué pasa si me reenvían el email?”

> El MVP prueba posesión de una evidencia autenticada. No garantiza control permanente del inbox. Para proof of inbox ownership se necesita un challenge fresco o recipient binding.

## “¿Por qué esto es una empresa?”

> Porque muchas apps necesitan evidencia de sistemas que no ofrecen APIs, credenciales portables o integraciones directas. Email ya es la capa interoperable.

## “¿Esto es sólo ZK Email?”

> ZK Email produce proofs sobre emails. MailProof es la capa de producto y adaptación para Midnight: claims normalizados, attestation bridge, Compact state, one-time redemption, SDK de consumo y UX.

---

# 53. Deck

Máximo ocho slides.

## Slide 1 — Título

```text
MailProof
Turn emails into private proofs.
```

Visual:

Email → proof → action.

## Slide 2 — Problema

```text
To prove one fact,
we hand over the whole email.
```

Mostrar datos tachados.

## Slide 3 — Insight

```text
Companies already issue signed evidence.
They call it email.
```

DKIM en una línea.

## Slide 4 — Producto

```text
Source sends normal email
User creates private proof
App verifies claim
Midnight prevents replay
```

## Slide 5 — Demo

Tres capturas:

- email;
- claim;
- unlocked action.

## Slide 6 — Architecture

```text
.eml local
  → ZK Email proof
  → MailProof attestor
  → Compact
  → dApp
```

Marcar trust boundary.

## Slide 7 — Extensión

```text
flight cancellation
purchase receipt
event registration
employment offer
membership
official notice
```

## Slide 8 — Cierre

```text
The sender does not need Midnight.
The verifier gets only the claim.
```

---

# 54. README

El README debe estar completo.

Orden:

1. hero;
2. one-liner;
3. problem;
4. demo GIF/video;
5. what works;
6. architecture;
7. privacy model;
8. trust boundary;
9. quickstart;
10. prerequisites;
11. version matrix;
12. contract;
13. ZK Email blueprint;
14. attestor;
15. tests;
16. demo;
17. limitations;
18. roadmap;
19. team;
20. license.

## 54.1 `What works today`

Debe ser preciso.

Ejemplo:

```text
- Local `.eml` ingestion
- ZK Email proof generation for the pinned blueprint
- Off-chain deterministic proof verification
- Signed MailProof claim
- Compact verification of the signed claim
- Context-bound one-time redemption
- Replay rejection
```

## 54.2 `Current boundaries`

Incluir:

- attestor trust;
- one email template;
- `.eml` upload;
- wallet friction;
- local devnet if applicable;
- possession vs inbox ownership;
- no direct external-proof verification in Compact;
- no claim of objective truth.

---

# 55. Business and adoption

## 55.1 Supply-side adoption

El emisor del email no integra.

Ejemplos:

- aerolínea;
- tienda;
- universidad;
- evento;
- banco;
- empleador.

Esto reduce fricción.

## 55.2 Demand-side adoption

Integra quien necesita el claim.

Ejemplos:

- seguro;
- lender;
- dApp;
- marketplace;
- gated community;
- rewards program;
- compliance workflow.

## 55.3 Usuario

El usuario obtiene:

- menos data sharing;
- menos uploads;
- menos validación manual;
- claim portable;
- respuesta más rápida.

## 55.4 Developer

El developer obtiene:

- blueprint;
- prover adapter;
- claim schema;
- verifier;
- Compact adapter;
- replay protection;
- UI components.

## 55.5 Producto futuro

```text
MailProof SDK
Blueprint Registry
Midnight Claim Adapter
Verifier API
Enterprise Blueprint Studio
Attestor Network
```

## 55.6 Modelo de ingreso posible

- fee por verified claim;
- subscription por dApp;
- private blueprint hosting;
- enterprise support;
- managed attestation;
- compliance/audit package.

No vender tokenomics.

---

# 56. Casos de extensión

## 56.1 Compra

Claim:

> Recibí un recibo auténtico de un merchant autorizado para este producto.

Consumidor:

- garantía;
- rewards;
- financiación;
- devolución.

## 56.2 Evento

Claim:

> Recibí una confirmación auténtica de registro.

Consumidor:

- gated community;
- badge;
- access;
- follow-up benefit.

## 56.3 Empleo

Claim:

> Recibí una oferta de empleo de un dominio autorizado.

Consumidor:

- alquiler;
- onboarding;
- beneficio;
- visa workflow.

No revelar salario si no es necesario.

## 56.4 Reserva

Claim:

> Recibí confirmación de una reserva válida.

Consumidor:

- insurance;
- access;
- loyalty;
- escrow.

## 56.5 Educación

Claim:

> Recibí una notificación oficial de admisión o aprobación.

Consumidor:

- scholarship;
- community;
- onboarding.

## 56.6 Membership

Claim:

> Controlo una casilla de un dominio o recibí una invitación específica.

Consumidor:

- private community;
- employee benefits;
- governance eligibility.

## 56.7 Bank notification

Claim:

> Un banco autorizado firmó una notificación específica.

Cuidado:

No afirmar saldo o solvencia salvo que el template lo pruebe.

---

# 57. Diferenciación

## 57.1 Contra screenshots

- screenshots son editables;
- no tienen sender authentication;
- exponen contenido;
- requieren revisión manual.

## 57.2 Contra forwarding

- forwarding entrega el mensaje;
- agrega PII;
- crea almacenamiento;
- no estandariza claims.

## 57.3 Contra APIs

Una API puede ser mejor si existe y el usuario autoriza acceso.

MailProof es útil cuando:

- no existe API;
- la API es costosa;
- el emisor no integra;
- el usuario quiere revelar menos;
- el email ya contiene la evidencia.

## 57.4 Contra credenciales nuevas

Pedir a cada aerolínea que emita una credencial nueva crea adoption friction.

MailProof reutiliza email.

## 57.5 Contra ZK Email puro

No competir con ZK Email.

Construir encima.

ZK Email:

- DKIM proof;
- blueprint;
- prover;
- verification.

MailProof:

- claim semantics;
- Midnight bridge;
- signed attestation;
- Compact consumption;
- nullifiers;
- developer SDK;
- user flow;
- dApp integration.

Dar crédito claro.

---

# 58. Rubric mapping

## Engineering — 40

Mostrar:

- Compact compila;
- signature verification;
- public/private boundary;
- nullifier;
- Midnight state transition;
- local ZK Email proof;
- end-to-end integration;
- clean architecture.

## QA — 15

Mostrar:

- positive tests;
- tampered email;
- invalid proof;
- invalid signature;
- replay;
- wrong campaign;
- reset;
- backup.

## Product — 15

Mostrar:

- exact problem;
- no issuer integration;
- one claim;
- extension path;
- honest trust model.

## UX — 15

Mostrar:

- `.eml` drop;
- local processing;
- reveal/private panel;
- clear progress;
- clear errors;
- immediate result.

## Communication — 10

Mostrar:

- one sentence;
- attack;
- replay;
- clear Midnight role;
- concise deck.

## Business — 5

Mostrar:

- verifier is buyer;
- sender adoption not required;
- blueprint SDK;
- real use cases.

---

# 59. Submission checklist

- [ ] Repository public.
- [ ] Apache-2.0 `LICENSE`.
- [ ] Required GitHub label/topic.
- [ ] Compact contract included.
- [ ] Contract compiles from clean clone.
- [ ] Frontend connected.
- [ ] Tests documented.
- [ ] README complete.
- [ ] Architecture diagram.
- [ ] Privacy and threat model.
- [ ] Demo video.
- [ ] Pitch deck.
- [ ] Public links work.
- [ ] No secrets.
- [ ] No personal email fixture.
- [ ] Exact versions pinned.
- [ ] Known limitations visible.
- [ ] Reset procedure works.
- [ ] Backup proof and video available.
- [ ] Final commit hash recorded.

---

# 60. Definition of done

MailProof is done when all statements are true.

## Contract

- Compact compiles.
- Valid signed claim succeeds.
- Invalid signature fails.
- Wrong campaign fails.
- Replay fails.
- State changes once.
- Tests pass.

## Email

- A pinned blueprint validates one fixture.
- Local proof generation works or a verified local proof fixture exists.
- Proof verifies.
- Tampered email fails.
- Public outputs contain only expected fields.

## Attestor

- Only allowlisted blueprint.
- Re-verifies proof.
- Builds canonical claim.
- Signs with Midnight-compatible signature.
- Does not log raw email.
- Tests pass.

## Integration

- User imports `.eml`.
- UI shows private/revealed.
- Claim reaches Midnight.
- Result is confirmed.
- Second redemption fails.
- Reset works.

## Delivery

- README.
- deck.
- video.
- source.
- license.
- labels.
- known limitations.
- demo runbook.

---

