# Plan — Organigrama por personas y leads de marketing según quién depende de quién

> Sistema: **ESAM Seguimiento** (`baileys_esam`). Versión 2 — 2026-11-24, con las
> respuestas Q1–Q10. Se apoya en lo que ya está en `origin/main` (commits
> `39f091a`…`709bb27`: unidades de negocio, sedes por unidad, cargos por área y
> organigrama por cargos). **No usa `/agenda`.** Ruta nueva: **`/leads`**.
> Primero se prueba acá; cuando esté bien plasmado se replica en ESAM HUB (Q8).
>
> **Estado (2026-11-24):** ✅ L0 (`src/core/organigrama.ts`, tests `organigrama.test.ts`) ·
> ✅ L1 (`src/panel/organigrama-views.ts`: ficha de sede → Organigrama, `/organigrama` para el
> Gerente General, `POST /organigrama/jefe`; tests `organigrama-views.test.ts`) ·
> ✅ L2 (`src/core/leads.ts`: alta desde prospectos y desde el primer mensaje en vivo a una
> línea de Marketing, actividad por mensajes, migración única de prospectos existentes
> `leadsDesdeProspectosV1`; tests `leads.test.ts`) ·
> ✅ L3 (`/leads`: `src/panel/leads-views.ts` + `src/core/leads-vista.ts`, tablero por etapa con
> filtros, ficha en panel lateral, arrastrar solo lo propio; tests `leads-views.test.ts`). Ya
> trae lo básico de L4 (los jefes ven a su gente, con selector de persona y solo lectura) · ⏳ L4.

---

## 1. Qué se quiere

En **Unidades de negocio (`/unidades`) → Sede → Organigrama**, ver quién depende de quién
**persona por persona**, y que eso decida qué leads ve cada uno (**solo área Marketing**, Q5):

| Cargo | Ve los leads de… |
|---|---|
| **Gerente de sede** (Gerente General) | Todos los de marketing de su sede. |
| **Gerente de Marketing** | Todo su subárbol: sus supervisores y los asesores de ellos (Q1). |
| **Supervisor de Marketing** | Solo los asesores **a su cargo** (no los de otro supervisor). |
| **Asesor de Marketing** | Solo los suyos. |
| Super Admin | Todo. |

Los jefes **solo miran y comentan** (Q4): no mueven etapas ni reasignan.

---

## 2. Lo que ya existe (en `origin/main`)

- **`/unidades`**: `business_units` → `sedes.business_unit_id` → usuarios de la sede, con
  ficha de sede y pestaña **Organigrama** (`renderOrgChart` en `src/panel/admin-views.ts`).
- **`/cargos`**: `cargos` por área (`Marketing`, `Contabilidad`, `Académica`, `Dirección`) con
  **dependencia entre cargos** (`parent_id`, sin ciclos). Cada persona tiene área y cargo
  (`users.esam_area`, cargo en `users.esam_roles`).
- **El hueco:** el organigrama actual dibuja **cargos** y mete a las personas en cada caja.
  Si una sede tiene dos supervisores, sus asesores aparecen todos juntos en la caja
  «Asesor de Marketing»: no se sabe **de qué supervisor** es cada uno. Y `sessionScopeFor`
  da al gerente y al supervisor de marketing **todas** las líneas de marketing de la sede.

> ⚠️ **Antes de empezar:** la copia local de `baileys_esam` está **10 commits atrás** de
> `origin/main` y tiene un commit propio (`ad38224`) que no está arriba. Hay que
> integrarlos (`git pull --rebase` o merge) antes de tocar código.

---

## 3. Lo que se agrega

### 3.1 Jefe directo de cada persona

```sql
ALTER TABLE users ADD COLUMN jefe_id INTEGER;      -- NULL = no depende de nadie en la sede
CREATE INDEX idx_users_jefe ON users(jefe_id);

CREATE TABLE organigrama_cambios (                  -- quién movió a quién (control)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, jefe_anterior INTEGER, jefe_nuevo INTEGER,
  cambiado_por INTEGER NOT NULL, created_at TEXT NOT NULL
);
```

**Reglas** (en el servidor, `src/core/organigrama.ts`):
- Jefe y persona en **la misma sede**.
- El **cargo del jefe** tiene que ser el **cargo del que depende** el cargo de la persona en
  `/cargos` (p. ej. Asesor → Supervisor). Así el organigrama de personas respeta el de cargos.
- **Un solo jefe** por persona (Q2). Sin ciclos.
- El SSO de cronogramas nunca pisa `jefe_id`.
- Si se cambia el cargo de alguien y su jefe ya no corresponde, `jefe_id` vuelve a NULL y la
  persona aparece en «Sin jefe asignado».
- Al quitar o desactivar a un jefe, su gente pasa a «Sin jefe asignado» y se avisa al gerente de sede.

**Quién edita** (Q3): Super Admin y el **Gerente de la sede** (solo la suya).

### 3.2 La regla de visibilidad (una sola función)

```ts
/** Ids de usuarios cuyos leads ve `user` (solo Marketing). null = todos. */
export function alcanceLeads(user: UserRow): number[] | null
```

- Super Admin → `null`.
- Gerente de sede → todos los usuarios de marketing de su sede.
- Cualquier otro → él + su subárbol por `jefe_id` (CTE recursivo). Para el Gerente de
  Marketing eso es supervisores + asesores (Q1); para el supervisor, sus asesores; para el
  asesor, solo él.

```sql
WITH RECURSIVE equipo(id) AS (
  SELECT id FROM users WHERE id = :yo
  UNION ALL SELECT u.id FROM users u JOIN equipo e ON u.jefe_id = e.id
) SELECT id FROM equipo;
```

Se aplica en **cada** endpoint de `/leads` y sus APIs. Un lead fuera del alcance responde
**404** (ni siquiera confirma que existe). El inbox y `/notes` siguen como hoy (ver §7, L5).

### 3.3 El lead de marketing

Un lead es (Q6) **las dos cosas**:
1. **Prospecto** registrado en cronogramas (ya llega por `src/core/prospects.ts`).
2. **Contacto nuevo** que escribe por primera vez a la línea de un asesor de marketing.

```sql
CREATE TABLE leads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sede_id         INTEGER NOT NULL,
  owner_user_id   INTEGER NOT NULL,          -- el asesor dueño (dueño de la línea)
  session_id      TEXT NOT NULL,             -- línea de WhatsApp
  contact_id      INTEGER,                   -- ficha de la persona
  phone_key       TEXT NOT NULL,             -- un lead por persona y asesor
  origen          TEXT NOT NULL,             -- 'prospecto' | 'linea'
  prospect_ref    TEXT,                      -- 'mp:15' si vino de cronogramas
  programa        TEXT,
  etapa           TEXT NOT NULL DEFAULT 'nuevo',  -- nuevo|contactado|interesado|no_interesado|inscrito
  ultimo_contacto_at TEXT,                   -- último mensaje del asesor
  ultima_actividad_at TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, phone_key)
);
CREATE TABLE lead_eventos (   -- historial: etapa, comentario de jefe, origen
  id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, user_id INTEGER,
  tipo TEXT NOT NULL, -- 'etapa' | 'comentario' | 'creado'
  texto TEXT, de TEXT, a TEXT, created_at TEXT NOT NULL
);
```

- **Etapas**: las mismas cinco de cronogramas (`PROSPECT_STATES`), para que el día que se
  sincronice (Q10) sea uno a uno.
- **Quién mueve la etapa**: solo el asesor dueño (Q4). Si cronogramas cambia el estado de un
  prospecto, se refleja acá (como hoy). **La escritura de vuelta a cronogramas queda para
  después** (Q10): hasta entonces, una etapa movida en Seguimiento no viaja a cronogramas.
- **Contacto nuevo por la línea**: nace en «Nuevo» con el primer mensaje entrante de una
  persona que no es lead de ese asesor, solo en líneas de **área marketing**. Se excluyen
  grupos, contactos marcados como internos y los que ya son prospectos (se unen por
  `phone_key`).
- `ultimo_contacto_at` y `ultima_actividad_at` se actualizan con los mensajes: son la base
  de las alertas «sin contactar» y «sin movimiento».

---

## 4. Pantallas

### 4.1 Organigrama por personas (`/unidades/{u}/sedes/{s}` → pestaña Organigrama)

Se **reemplaza el dibujo por cargos** por uno **por personas**, como la referencia:
- Raíz: **Gerente de sede** (caja destacada). Debajo, una columna por cada persona que
  depende directo de él (p. ej. **Gerente de Marketing**). Debajo, sus **Supervisores**, y de
  cada supervisor la **lista de sus asesores**.
- Cada caja: cargo, nombre, iniciales y **cifras de control** (solo marketing): leads abiertos,
  nuevos sin contactar, sin movimiento > 7 días. Clic → `/leads` filtrado por esa persona.
- **Modo edición** (Super Admin / Gerente de sede): botón «Editar dependencias» → cada caja
  muestra «Depende de: [▼]» con **solo los jefes válidos** según `/cargos`. Bandeja lateral
  **«Sin jefe asignado»**. Guardar valida §3.1 y deja traza.
- Las otras áreas se siguen viendo por cargos como hoy (Q5: se analizan después).
- Móvil: árbol como lista anidada plegable.

### 4.2 Ruta nueva **`/leads`** — «Leads de marketing»

En el menú del panel, visible para Super Admin, Gerente de sede y personas de área marketing.

**Asesor**
- Tablero de **sus** leads: columnas **Nuevo · Contactado · Interesado · No interesado · Inscrito**.
- Selector **por programa** («Todos» o un programa) — sus pipelines (Q5).
- Tarjeta: nombre, programa, origen (Prospecto / WhatsApp), días sin contacto, último
  comentario del jefe (🔔 si no lo leyó). Arrastra entre columnas.
- Clic → panel lateral: datos, **conversación de su línea**, notas, historial y comentarios.
- Filtros: «sin contactar», «sin movimiento X días», origen, búsqueda.

**Supervisor · Gerente de Marketing · Gerente de sede**
- **Selector de equipo** que sale del organigrama:
  `Sede Sucre › Ana (Gte. Marketing) › Luis (Supervisor) › [Todos | asesor ▼]`.
  Solo muestra gente de su alcance.
- **«Mi equipo»** (vista de control): una fila por persona a cargo → leads por etapa,
  conversión a inscrito, nuevos sin contactar en 24 h, sin movimiento > 7 días.
  Un gerente ve sus supervisores con el total de cada uno y puede bajar a sus asesores.
- **Tablero** de una persona o de todo su equipo (tarjeta con la inicial del asesor),
  **solo lectura**: no arrastra.
- **Comentar** en un lead (Q4): queda en el historial y le llega un aviso al asesor.
  Nada más: no mueve ni reasigna.

---

## 5. Seguridad y control

- `alcanceLeads` en el servidor en **todas** las consultas y acciones de `/leads`. Tests de
  «no ve» para cada cargo (asesor de otro supervisor, otra sede, otra área).
- Mover etapa: solo el dueño. Comentar: dueño y quien tenga al dueño en su alcance.
- Cambios del organigrama en `organigrama_cambios` + `audit_logs`.
- Las conversaciones que se muestran en `/leads` son solo las de la **línea del dueño**.

---

## 6. Cómo se pasa al HUB después (Q8)

Lo que se replica es **el modelo**, no el código:
`jefe_id` por persona + `alcanceLeads` (CTE) + etapas + comentarios de jefe. En el HUB
eso reemplaza la regla de dos niveles de hoy (`AgentContext::leads()`: admin todo / resto
lo suyo) y sirve para WhatsApp API (ESAM Conecta) y los demás canales. Para no rehacer
el organigrama a mano, Seguimiento expondrá `GET /api/v1/organigrama` (por sede) y el HUB
lo importará una vez. Se planifica cuando L4 esté validado.

---

## 7. Fases

| Fase | Qué | Puerta de salida |
|---|---|---|
| **L0** | Integrar la copia local con `origin/main`. Migraciones `jefe_id`, `organigrama_cambios`, `leads`, `lead_eventos`. `organigrama.ts` (validar jefe, `alcanceLeads`). | Tests: los 5 cargos de §1, jefe de otra sede o cargo inválido rechazado, ciclo rechazado, SSO no pisa `jefe_id`. |
| **L1** | Organigrama **por personas** en la ficha de sede + edición de dependencias. | Super Admin arma la sede piloto; dos supervisores muestran cada uno a SUS asesores. |
| **L2** | Leads: alta desde prospectos (y migración de los existentes) y desde el primer mensaje a una línea de marketing; actividad por mensajes. | Prospecto nuevo y contacto nuevo aparecen una sola vez, con su dueño correcto. |
| **L3** | **`/leads` del asesor**: tablero, programas, filtros, panel lateral, mover etapa. | Un asesor ve solo lo suyo; otro asesor recibe 404 en un lead ajeno. |
| **L4** | **Vista de jefes**: selector de equipo, «Mi equipo», tablero de solo lectura, comentarios con aviso. | Supervisor solo su gente; gerente de marketing todo su subárbol; gerente de sede toda la sede. |
| **L5** | (Después) Inbox y `/notes` con la misma regla; etapas hacia cronogramas (Q10); otras áreas (Q5); réplica en el HUB (Q8). | Se decide al cerrar L4. |

Estimación L0–L4: unas 5 sesiones.

---

## 8. Decisiones tomadas

| | Respuesta |
|---|---|
| Q1 | El Gerente de Marketing ve todo su subárbol. |
| Q2 | Cada asesor depende de **un** supervisor. |
| Q3 | Editan el organigrama el Super Admin y el Gerente de la sede. |
| Q4 | Los jefes solo miran y comentan. |
| Q5 | Solo Marketing; las otras áreas, después. |
| Q6 | Lead = prospecto de cronogramas **y** contacto nuevo por la línea. |
| Q7 | Ruta **`/leads`**. |
| Q8 | Se prueba en Seguimiento; después se replica en el HUB. |
| Q9 | Se usa `/unidades` tal como está (alta de unidades y sedes sin cambios). |
| Q10 | La escritura de etapas hacia cronogramas, después. |

**Pendiente menor (se puede decidir en L2):** ¿cuántos días sin mensaje del asesor cuentan
como «sin movimiento»? Propuesta: 7, configurable por sede.
