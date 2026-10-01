# Évolution du MCP Broker pour SCADA v1

## mcp-scada configure, le broker décide, mcp-scada applique

Date : 1er octobre 2026
Base : `@cyanmycelium/mcp-broker` 1.4.0, `@cyanmycelium/mcp-broker-provider` 0.2.x, `@cyanmycelium/mcp-core` 1.3.0
Origine : [validation du brief SCADA v1](validation-architecture-v1.md), écarts A1, A2 et A3

## Décision proposée

Le MCP Broker est le **seul** point de décision. `mcp-scada` ne compile aucune policy et n'évalue aucune règle. Il fait trois choses :

1. il **configure** les autorisations du broker pour le domaine SCADA : ressources UNS, capabilities, limites d'ingénierie, slots protocolaires à protéger ;
2. il **demande** au broker une décision pour chaque opération, avec le contexte industriel de la requête ;
3. il **applique** la décision reçue, puis rend compte de l'exécution au broker, qui tient l'audit.

En termes classiques, le broker est le point de décision (PDP) et `mcp-scada` le point d'application (PEP). Le broker reste aussi le point d'application pour tout ce qui ne passe pas par SCADA.

Toutes les évolutions sont additives. Un broker sans déclaration SCADA se comporte exactement comme la version 1.4.0.

## Ce que mcp-scada peut configurer, et ce qu'il ne peut pas

Le brief SCADA v1 pose une règle (§4.4) : une déclaration provider ne peut jamais élargir une autorisation. `mcp-scada` étant lui-même un provider du broker, sa configuration est donc **descriptive** :

| mcp-scada déclare | Le broker garde |
|---|---|
| L'espace de ressources UNS qu'il sert | Les sujets (identités issues du JWT) |
| Le vocabulaire de capabilities (`scada.observe`, `scada.acquire`, `scada.control`, `scada.execute`) | Les rôles et les assignations sujet / rôle / sous-arbre |
| L'effet et les limites d'ingénierie de chaque ressource (plage d'une consigne) | Les denies explicites |
| Les slots protocolaires qu'il est seul à pouvoir appeler | Les obligations par acteur : approbation, contraintes, expiration |
| | La décision, son versionnement et l'audit |

Une déclaration ne contient **aucune attribution de droit**. Si elle en contenait, `mcp-scada` pourrait s'autoriser lui-même, ce que le §13 interdit explicitement. Les limites d'ingénierie, elles, ne font que restreindre : elles s'ajoutent à la décision sans jamais l'élargir.

## Synthèse

| # | Évolution | Écart couvert | Priorité | Paquets |
|---|---|---|---|---|
| E1 | Déclaration d'autorisation par un provider | A2, A3, protection des slots | Bloquant | broker, provider |
| E2 | Référence d'appelant transmise au provider | A1 | Bloquant | broker, mcp-core |
| E3 | API de décision `broker/authorize` | A1, A2, A3 | Bloquant | broker, provider |
| E4 | Décisions avec obligations | A2 | Bloquant pour `control` et `execute` | broker |
| E5 | Audit unique tenu par le broker | §6 du brief | Haute | broker, provider |
| E6 | Conditions sur attributs | A3 | Optionnelle | broker |

Les limites de débit restent hors du broker en v1 (voir la fin du document).

## Flux canonique

```text
Client MCP            MCP Broker                                  mcp-scada                   slot Modbus
    |                     |                                            |                            |
    | tools/call          |                                            |                            |
    | scada.write ------->| JWT -> sujets                              |                            |
    |                     | contrôle grossier du slot `scada`          |                            |
    |                     | _meta.caller = { ref, correlationId } ---->|                            |
    |                     |                                            | résout l'UNS, vérifie      |
    |                     |                                            | la capability du provider  |
    |                     |<-- broker/authorize { principal, checks } -|                            |
    |                     | évalue : sujets du ref, capability,        |                            |
    |                     | ressource UNS, obligations, limites        |                            |
    |                     | déclarées ; audite la décision             |                            |
    |                     |---- decisions[] { effect, obligations,  -->|                            |
    |                     |                   decisionId }             |                            |
    |                     |                                            | applique les obligations   |
    |                     |                                            | juste avant l'exécution    |
    |                     |                                            |---- modbus.write --------->|
    |                     |<---- broker/audit/result { decisionId, ----|<---------------------------|
    |                     |      result, nativeStatus }                |                            |
    |<--------------------|<-------------------------------------------| résultat normalisé         |
```

Le broker ne lit jamais les arguments de `scada.write`. Il n'a pas à connaître la forme des outils SCADA, les listes de repli, ni le filtrage d'un `browse` : c'est `mcp-scada` qui formule chaque question, et le broker qui y répond.

### Pourquoi pas une décision dans la trame relayée

Une alternative serait que le broker décide en relayant la requête, en extrayant la ressource des arguments de l'outil. Elle ne tient pas pour SCADA :

- une lecture avec repli explicite (`["local", "source"]`) demande une décision par destination, connue seulement pendant l'exécution ;
- un `browse` filtre chaque nœud renvoyé par le provider, après coup ;
- une contrainte doit être vérifiée juste avant l'exécution, et une future phase `prepare` / `commit` revalidera une décision plus tard ;
- le broker devrait connaître la forme des arguments de chaque outil SCADA, et suivre leurs évolutions.

La question explicite (E3) couvre tous ces cas avec une seule API, sans que le broker connaisse SCADA.

## E1. Déclaration d'autorisation par un provider

### Constat

La policy du broker est compilée au démarrage depuis `config.json`. Un provider ne peut rien y déclarer. Les ressources SCADA n'existent pas pour le broker, et rien n'empêche un client d'appeler directement le slot Modbus en contournant SCADA.

### Proposition

Un provider authentifié envoie sa déclaration au broker sur son propre socket. Les méthodes `broker/*` deviennent un espace réservé : une trame provider dont `method` commence par `broker/` est consommée par le broker et jamais relayée. Une méthode `broker/*` inconnue, ou refusée à ce provider, reçoit **immédiatement** une erreur JSON-RPC (`-32601` ou `-32003`) : le broker ne laisse jamais une requête provider sans réponse.

`notifications/register` n'est **pas** un précédent suffisant : `_tryHandleRegistration` n'inspecte que le premier message du socket. Les requêtes `broker/*` arrivent à n'importe quel moment. Il faut donc un nouvel aiguillage dans `WsTunnel._routeFromProvider`, placé **avant** la recherche de l'`id` dans `pending` (une requête provider porte un `id` et serait sinon prise pour une réponse), sur `/provider/<name>` comme dans l'enveloppe `{ provider, payload }` de `/providers`.

En v1, seuls les providers WebSocket authentifiés et les providers loopback peuvent déclarer. Les entrées `stdioUpstreams[]`, `mcpServers[]` et `mcpbBundles[]` n'ont pas de principal provider : une trame `broker/*` venant d'eux reçoit immédiatement un refus.

```json
{
  "jsonrpc": "2.0",
  "id": "decl-1",
  "method": "broker/authorization/declare",
  "params": {
    "version": "2026-10-01.1",
    "domain": "scada",
    "namespace": { "resource": "/production/site1" },
    "capabilities": ["scada.observe", "scada.acquire", "scada.control", "scada.execute"],
    "resources": [
      {
        "resource": "uns://production/site1/line1/motor01/speed_setpoint",
        "resourcePath": "/production/site1/line1/motor01/speed_setpoint",
        "effect": "physical-action",
        "limits": { "minValue": 0, "maxValue": 1500 }
      }
    ],
    "protects": ["bench-motor01", "opcua-line1"]
  }
}
```

Réponse : `{ "accepted": true, "version": "2026-10-01.1", "policyVersion": "..." }`, ou une erreur listant chaque problème.

Le broker valide avant d'accepter :

- **Provider authentifié.** Une déclaration venant d'un provider anonyme est refusée. Un provider loopback est accepté.
- **Espace couvert.** `namespace.resource` doit être couvert par les `allowedResources` du principal du provider. C'est la règle qui existe déjà pour la publication d'un slot (`providerMayPublish`).
- **Deux identifiants.** Chaque ressource (`resources[]`, `checks[]`) porte son identifiant natif `resource` et son chemin `resourcePath`, fourni par le provider ; seul le chemin est évalué, après contrôle d'appartenance. Voir « Deux identifiants par ressource » ci-dessous.
- **Pas de droit.** Les clés `assignments`, `roles` et `denies` sont refusées.
- **Capabilities préfixées par le domaine.** Un provider de domaine `scada` ne déclare que des capabilities `scada.*`. Il ne peut pas déclarer `mcp.tools.call` ni `*`.
- **Slots protégés.** Chaque slot de `protects` doit être lui-même couvert par les `allowedResources` du provider qui déclare. Une fois accepté, le slot n'est plus joignable que par le provider déclarant (voir l'identité ci-dessous), et il est retiré de `_all`. Cela ferme le contournement de SCADA par un appel direct à `modbus.read`.
- **Atomicité.** Une déclaration remplace entièrement la précédente du même provider. La clé est l'`IProviderPrincipal.id`, et non le slot : un même principal publié sur deux slots n'a qu'une déclaration. La policy compilée reste immuable : chaque déclaration acceptée produit une nouvelle version, et une décision indique la version qui l'a produite.
- **Cycle de vie.** La déclaration survit à une déconnexion du provider : une coupure réseau ne doit pas rouvrir les slots protégés. Seules une nouvelle déclaration ou une action d'administration la retirent.

### Deux identifiants par ressource

Les assignations correspondent à des chemins (`/production/site1/line1/**`). Les providers, eux, nomment leurs ressources dans leur propre schéma : `uns://...` pour SCADA, des identifiants OPC UA, des topics MQTT, etc. Le broker ne traduit **rien** : le provider, qui connaît son schéma, fournit les deux formes partout où il nomme une ressource.

```json
{ "resource": "uns://production/site1/line1/motor01/speed_setpoint",
  "resourcePath": "/production/site1/line1/motor01/speed_setpoint" }
```

- `resourcePath` est la seule forme que le broker **évalue**. Il est analysé comme un `ResourcePath` (absolu, segments non vides, ni `.` ni `..`, pas de `/` encodé), puis doit être couvert par `namespace.resource` de la déclaration, lui-même couvert par les `allowedResources` du provider. Un échec donne `deny` / `undeclared-resource` (E3), ou le refus de la déclaration (E1).
- `resource` est l'identifiant natif. Le broker ne l'interprète pas ; il le garde pour l'audit et pour faire le lien avec `resources[]` de la déclaration.
- Pour une ressource listée dans `resources[]` (limites d'ingénierie, effet), le couple `resource` / `resourcePath` d'une question doit être celui de la déclaration : un même identifiant natif présenté avec un autre chemin est refusé, ce qui empêche d'échapper à une limite déclarée en changeant de chemin.

Ce choix n'affaiblit rien. La traduction n'a jamais été une frontière de sécurité : la frontière est le contrôle d'appartenance, toujours exécuté par le broker. Un provider qui calcule mal son chemin ne peut que se refuser à lui-même, ou confondre deux ressources **de son propre espace**, ce qu'il pourrait faire de toute façon en servant la mauvaise ressource. En échange, le broker n'a ni moteur de règles, ni expressions régulières à protéger, ni schéma à connaître, et un nouveau domaine ne demande aucune évolution du broker.

### Identité de l'appelant d'un slot protégé

Pour lire Modbus, `mcp-scada` est un **client** du slot `bench-motor01`. Il y est authentifié par la couche OAuth (`IPrincipal`, sujets dérivés du JWT), et non par son authentification provider (`IProviderPrincipal`). Ce sont deux systèmes distincts : « le principal du provider déclarant » n'a pas de sens côté client sans une correspondance explicite.

Règle retenue : un client est admis sur un slot protégé si l'un de ses sujets (dérivés du JWT par `subjectMapping`) figure dans `IProviderPrincipal.subjects` du provider déclarant. Ces sujets sont écrits par les administrateurs du broker dans la table `providers` du fichier de sécurité (voir ci-dessous), et non par la déclaration : la déclaration n'attribue toujours aucun droit. Un provider loopback qui appelle par `tunnel.openInternalClient()` est admis directement.

Conséquence pratique : un slot protégé n'est joignable que si l'authentification OAuth des clients est active et que `subjectMapping` produit le sujet attendu. Sans elle, tout client est anonyme et refusé ; c'est voulu, l'échec est fermé.

### Identités des providers

Avant cette évolution, la CLI ne connaissait qu'un secret partagé (`providerSecret`) : tous les providers qui le présentaient recevaient la même identité, `"shared-secret"`, sans `subjects`. Impossible alors de distinguer `mcp-scada` du provider Modbus. Le fichier de sécurité porte donc une table, une entrée par provider :

```json
{
  "providers": [
    { "id": "mcp-scada", "secretEnv": "SCADA_PROVIDER_SECRET", "subjects": ["service:mcp-scada"], "allowedResources": ["/production/site1/**"] },
    { "id": "modbus-bench", "secretEnv": "MODBUS_PROVIDER_SECRET", "allowedResources": ["/production/site1/bench/**"] }
  ]
}
```

- Chaque provider présente son propre secret (`X-Provider-Token` ou `Authorization: Bearer`) ; le fichier ne contient que le nom de la variable d'environnement qui le porte.
- `providerSecret` reste accepté à côté, pour la compatibilité, et donne toujours le principal `"shared-secret"`. Ce principal ne peut pas déclarer : il n'identifie personne en particulier.
- Côté bibliothèque : `WsTunnelBuilder.withProviderPrincipals()` (`ProviderTableAuthenticator`). Un provider loopback reçoit son principal par `registerLoopbackProvider(name, transport, { principal })`.

Un provider déclarant dont `subjects` est vide ne peut protéger aucun slot : la déclaration est refusée avec une erreur qui le dit, plutôt que de fermer le slot à tout le monde, `mcp-scada` compris.

### Protection côté publication

Fermer un slot aux clients ne suffit pas : un autre provider pourrait **publier** dans ce slot, à la place du vrai provider Modbus, et recevoir les écritures de `mcp-scada`. Pour un slot protégé :

- `providerMayPublish` exige, en plus des `allowedResources`, que le principal qui publie soit celui désigné par `publishedBy` (voir ci-dessous) ;
- la prise de place (`providerTakeover`) n'est permise qu'à ce même principal, quel que soit le mode configuré.

### Fermeture dès le démarrage

Une déclaration tenue en mémoire survit à une déconnexion, pas à un redémarrage du broker. Entre le redémarrage et la reconnexion de `mcp-scada`, les slots protégés seraient ouverts. Ils doivent donc aussi figurer dans le fichier de sécurité du broker (voir ci-dessous), écrit par ses administrateurs :

```json
{
  "authorization": {
    "protectedSlots": {
      "bench-motor01": { "declaredBy": "mcp-scada", "publishedBy": "modbus-bench" },
      "opcua-line1": { "declaredBy": "mcp-scada", "publishedBy": "opcua-line1" }
    }
  }
}
```

`declaredBy` et `publishedBy` sont des `IProviderPrincipal.id`. Un slot listé est fermé dès le démarrage, avant toute déclaration. La déclaration de `mcp-scada` ne fait que **confirmer** : un `protects` qui nomme un slot absent de `protectedSlots`, ou dont `declaredBy` désigne un autre principal, fait refuser la déclaration en entier. Une déclaration qui omet un slot listé ne le rouvre pas.

### Fichier de sécurité séparé

Aujourd'hui, toute la sécurité du broker vit dans `config.json`, avec la topologie : `auth`, `providerSecret` en clair, la policy. Et `loadBrokerConfig` qui ne parvient pas à lire ce fichier écrit une erreur puis continue avec `{}`, c'est-à-dire sans aucune authentification : un JSON mal formé ouvre tout. Y ajouter `protectedSlots` hériterait de ce défaut, une virgule en trop rouvrirait le slot Modbus.

La sécurité passe donc dans un fichier dédié, par exemple `.mcp-broker/security.json`, désigné par `config.json` (`"securityFile": "security.json"`, résolu par rapport au répertoire de `config.json`) ou par `MCP_BROKER_SECURITY_FILE` :

| `config.json` (topologie) | fichier de sécurité |
|---|---|
| port, hôte, origines, montages statiques | `auth` : paramètres OAuth, rôles, assignations, denies (le bloc actuel, sans `providerSecret`) |
| `stdioUpstreams[]`, `mcpServers[]`, `mcpbBundles[]` | `providers` : `id`, `secretEnv`, `subjects`, `allowedResources` |
| limites, délais, `providerTakeover` | `authorization.protectedSlots` |

Règles :

- **Échec fermé.** Un fichier de sécurité désigné mais absent, illisible ou invalide empêche le broker de démarrer. Il ne retombe jamais sur une configuration ouverte.
- **Droits séparés.** Le fichier n'est lisible que par le compte du broker et modifiable par les seuls administrateurs sécurité : qui change la topologie ne change pas les droits.
- **Version.** Le hash du fichier entre dans `policyVersion` (donc dans l'audit, E5) et figure dans `broker_info`.
- **Pas de secret en clair.** `providerSecret` et les secrets du même genre sont lus depuis une variable d'environnement ou un fichier de secrets ; le fichier de sécurité ne contient que leur référence.
- **Signature optionnelle (lot 3).** Le fichier pourra être accompagné d'une signature détachée (`security.json.sig`), vérifiée avec une clé publique de confiance, par le mécanisme déjà en place pour `mcpbBundles[]`. Quand une clé est configurée, une signature absente ou invalide empêchera le démarrage. Reportée au lot 3 : elle ne change pas le format du fichier.
- **Compatibilité.** La section `auth` de `config.json` reste lue tant qu'il n'y a pas de fichier de sécurité. Si elle coexiste avec un fichier de sécurité, le broker refuse de démarrer plutôt que de choisir entre les deux en silence. Les clés `providers` et `authorization` sont refusées dans `config.json`, avec ou sans fichier de sécurité : laissées là, elles seraient ignorées, et une protection écrite par l'exploitant n'existerait pas.

Les assignations qui donnent ces capabilities aux opérateurs restent dans le fichier de sécurité du broker (voir « Fichier de sécurité séparé »), écrites par ses administrateurs :

```json
{
  "auth": {
    "roles": {
      "scada-observer": { "capabilities": ["scada.observe"] },
      "scada-operator": { "inherits": ["scada-observer"], "capabilities": ["scada.acquire", "scada.control"] }
    },
    "assignments": [
      { "id": "line1-operators", "subject": "group:operators-line1", "role": "scada-operator", "resource": "/production/site1/line1/**" }
    ]
  }
}
```

Le broker n'a aujourd'hui aucune notion de vocabulaire de capabilities : `validateCapability` ne vérifie que la forme de la chaîne. La règle à poser est donc nouvelle : une capability préfixée par un domaine (`scada.*`) qui n'est déclarée par aucun provider au chargement ne fait pas échouer le démarrage. Elle produit un avertissement, que `broker_diagnose` reprend tant qu'aucune déclaration ne la couvre.

## E2. Référence d'appelant

### Constat

`WsTunnel._authorizeMcpFrame()` dérive les sujets de l'appelant puis relaie la trame telle quelle : le provider ne sait pas qui appelle. Côté serveur, `IMcpBehaviorAdapter.executeToolAsync(uri, toolName, args)` ne voit pas non plus `params._meta`.

### Proposition

Vers un provider qui a une déclaration acceptée, le broker ajoute à chaque requête une **référence opaque** à l'appelant, et non son identité :

```json
"_meta": {
  "io.cyanmycelium/caller": {
    "ref": "cr_5b0d9e7f2a4c",
    "correlationId": "req-7f31"
  }
}
```

- La référence n'a de sens que pour le broker. `mcp-scada` la renvoie telle quelle dans `broker/authorize`, sous la forme `principal: { "type": "caller-ref", "ref": ... }`, et le broker y retrouve les sujets qu'il a lui-même dérivés du JWT. `mcp-scada` ne peut donc ni inventer ni modifier une identité.
- Elle est liée au slot et à la requête en cours. Elle expire à la réponse du provider, sans délai de grâce : les trames d'un même socket arrivent dans l'ordre, donc le provider pose toujours sa question avant de répondre. Elle ne permet pas de demander une décision au nom d'un utilisateur absent.
- Le broker **supprime** toute clé `io.cyanmycelium/caller` présente dans une requête client, sur tous les slots, avant toute évaluation.
- Ni le token ni les claims ne sont transmis.
- Seules les requêtes (trames avec `id`) portent une référence. Une notification client n'en porte pas.

### Ancrage dans le broker

Le broker réécrit déjà l'`id` de chaque requête client en un `brokerId` propre (`WsTunnel._trackRequest`), et le libère quand la réponse revient (`_routeFromProvider`) ou à l'échéance de `providerRequestTimeoutMs`. La référence d'appelant s'ancre à cet endroit : créée avec l'entrée de `pending`, liée au `brokerId`, au slot et au principal provider du socket, révoquée avec elle. `broker/authorize` refuse une référence dont l'entrée n'existe plus, qui appartient à un autre slot, ou qui est présentée sur le socket d'un autre provider.

### Appels passés par `_all`

L'agrégat n'atteint pas un provider avec l'identité du client réel : `AggregateServer` passe par **un** client interne par slot (`openInternalClient`), et les frames internes ne passent pas par `_authorizeMcpFrame`. Si `mcp-scada` est membre de `_all`, c'est donc `AggregateServer` qui injecte `_meta["io.cyanmycelium/caller"]`, au moment où il connaît le principal de l'appelant (`_policyAllows`), après avoir supprimé toute clé de ce nom reçue du client. Sans cela, tout appel SCADA passé par `_all` arriverait sans référence et serait refusé.

### Corrélation

En 1.5.0, le broker génère `correlationId` pour chaque requête. La reprise de l'en-tête `X-Correlation-Id` d'un client Streamable HTTP ou SSE est reportée au lot 3, avec l'audit unique (E5) : c'est là qu'elle sert.

### Évolution de mcp-core

Livrée dans mcp-core 1.4.0. Un contexte de requête optionnel, en dernier paramètre, sans casser les adapters existants :

```ts
export interface IMcpRequestContext {
    readonly requestId: string | number;
    readonly method: string;
    readonly meta?: Readonly<Record<string, unknown>>;
}

readResourceAsync(uri: string, request?: IMcpRequestContext): Promise<McpResourceContent | undefined>;
executeToolAsync(uri: string, toolName: string, args: Record<string, unknown>, request?: IMcpRequestContext): Promise<McpToolResult>;
getPromptAsync?(name: string, args: Record<string, string>, request?: IMcpRequestContext): Promise<McpPromptResult | undefined>;
completeAsync?(ref, argument, context?, request?: IMcpRequestContext): Promise<McpCompletion | undefined>;
```

- Le paramètre s'appelle `request` et non `context` : `completeAsync` avait déjà un `context`, le contexte de complétion MCP.
- `meta` est `params._meta`, copié et gelé ; absent quand la requête n'en porte pas ou quand ce n'est pas un objet.
- Pas de `signal` : le serveur ne gère pas l'annulation (`notifications/cancelled`), et un signal qui ne se déclenche jamais induirait en erreur. Ce sera un changement à part si le besoin apparaît.
- La ressource racine d'un `McpBehavior` est mise en cache et partagée entre appelants : elle est construite sans contexte. Un contenu qui dépend de l'appelant passe par une URI d'instance.
- Un adapter écrit pour 1.3.0, sans ce paramètre, fonctionne sans modification.

## E3. API de décision `broker/authorize`

### Proposition

Le provider pose une ou plusieurs questions en une seule requête :

```json
{
  "jsonrpc": "2.0",
  "id": "authz-42",
  "method": "broker/authorize",
  "params": {
    "principal": {
      "type": "caller-ref",
      "ref": "cr_5b0d9e7f2a4c"
    },
    "correlationId": "req-7f31",
    "checks": [
      {
        "capability": "scada.control",
        "resource": "uns://production/site1/line1/motor01/speed_setpoint",
        "resourcePath": "/production/site1/line1/motor01/speed_setpoint",
        "attributes": { "operation": "write", "destination": "source", "requestedValue": 1200 }
      }
    ]
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": "authz-42",
  "result": {
    "policyVersion": "2026-10-01.1",
    "decisions": [
      {
        "decisionId": "dec_91c2",
        "effect": "allow-with-constraints",
        "allowed": false,
        "reason": "role-grant",
        "policies": ["line1-operators"],
        "obligations": {
          "constraints": { "minValue": 0, "maxValue": 1500 },
          "notAfter": "2026-10-01T09:17:44Z"
        }
      }
    ]
  }
}
```

### Le champ `principal`

Il désigne **pour le compte de qui** la décision est demandée. Il n'y a que deux formes, distinguées par `type`, sans valeur magique :

| Forme | Usage | Sujets évalués par le broker |
|---|---|---|
| `{ "type": "caller-ref", "ref": "cr_..." }` | Une opération faite pour un client, pendant sa requête | Ceux que le broker a dérivés du JWT de ce client |
| `{ "type": "provider" }` | Une opération propre au provider : rafraîchissement d'un cache, abonnement de fond | Ceux du principal du provider (`IProviderPrincipal.subjects`, qui existe déjà) |

La référence n'est **pas** une identité. C'est un jeton éphémère, comparable à une capability, qui permet au provider de demander une décision dans le contexte d'un appel précis, et seulement de celui-là. Le nom `ref` le dit ; un champ `caller` aurait laissé croire qu'on peut y mettre `"user:alice"`.

Le broker refuse en entier une requête dont `principal` :

- a un `type` inconnu ;
- porte une identité en clair (`subject`, `subjects`, `user`, ou toute chaîne de la forme `prefixe:valeur`) ;
- est de type `provider` et porte aussi une `ref`, ou l'inverse.

Côté provider, l'appel se lit sans ambiguïté :

```ts
await broker.authorize({
    principal: { type: "caller-ref", ref: context.meta.caller.ref },
    correlationId: context.meta.caller.correlationId,
    checks: [...],
});
```

### Règles

- La ressource doit appartenir à l'espace déclaré par ce provider (E1). Une question hors de cet espace reçoit `deny` avec la raison `undeclared-resource` : un provider ne peut pas sonder les droits d'un utilisateur sur des ressources qui ne sont pas les siennes.
- La capability doit appartenir au vocabulaire déclaré.
- Les attributs sont transmis à l'audit. Ils ne sont évalués que si E6 est retenue.
- L'audit distingue les deux formes : une décision `provider` est enregistrée au nom du principal du provider, jamais au nom d'un utilisateur.
- Le broker audite chaque décision et renvoie un `decisionId` que l'exécution référence ensuite (E5).
- Les questions d'un `browse` sont groupées. Une limite de taille de lot (256 par défaut, `withAuthorizeBatchLimit()`) protège le broker.

En 1.5.0, avant le lot 4, `effect` ne vaut que `allow` ou `deny`, et `obligations` est absent. Chaque décision porte aussi `allowed`. Les raisons propres à cette API sont `undeclared-resource`, `undeclared-capability` et `no-policy` (le broker n'a pas de moteur de policy, il n'accorde donc rien). Une requête mal formée, une forme de `principal` refusée ou une référence qui n'est plus valide sur ce socket reçoivent `-32602` en entier ; un provider sans déclaration acceptée reçoit `-32003`.

Pour un provider loopback, la même API est exposée en processus par l'objet renvoyé par `tunnel.registerLoopbackProvider()` (`declare()`, `authorize()`). Côté `@cyanmycelium/mcp-broker-provider` 0.3.0, `DirectTransport` et `MultiplexTransport` exposent `transport.broker.declare()` et `transport.broker.authorize()` ; `broker.reportResult()` viendra avec le lot 3. Le client n'a pas de délai d'attente par défaut (`brokerRequestTimeoutMs` pour un broker antérieur à 1.4.1), et `callerReferenceOf(request?.meta)` lit la référence d'appelant.

## E4. Décisions avec obligations

### Constat

`IAuthorizationDecision` vaut `{ allowed, reason, matchedPolicies }`. Les rôles n'acceptent que `inherits` et `capabilities`. Le moteur ne peut exprimer ni approbation ni contrainte.

### Proposition

Les obligations par acteur se placent sur les **assignations**, écrites par les administrateurs du broker. Un rôle reste une simple liste de capabilities.

```json
{
  "id": "line1-start-stop",
  "subject": "group:operators-line1",
  "role": "scada-operator",
  "resource": "/production/site1/line1/**",
  "appliesTo": ["scada.execute"],
  "obligations": {
    "requireApproval": { "approvers": "group:shift-supervisors" }
  }
}
```

`appliesTo` restreint l'assignation à une partie des capabilities du rôle. Il est au niveau de l'assignation, et non dans `obligations` : il dit **quoi** est accordé, `obligations` dit **à quelle condition**. Absent, l'assignation porte toutes les capabilities du rôle.

La décision est étendue de façon rétrocompatible :

```ts
interface IAuthorizationDecision {
    readonly allowed: boolean;
    readonly reason: AuthorizationDecisionReason;
    readonly matchedPolicies?: readonly string[];
    readonly effect?: "allow" | "deny" | "require-approval" | "allow-with-constraints";
    readonly obligations?: {
        readonly constraints?: { readonly minValue?: number; readonly maxValue?: number; readonly allowedValues?: readonly unknown[]; readonly destinations?: readonly string[] };
        readonly notAfter?: string;
        readonly approval?: { readonly approvers: string; readonly policy: string };
    };
}
```

### Sémantique

Elle prolonge la règle actuelle, « un allow suffit, un deny explicite l'emporte toujours » :

1. un deny explicite qui correspond l'emporte ;
2. sinon, une assignation qui autorise sans obligation l'emporte ;
3. sinon, parmi les assignations avec contraintes, la plus spécifique (`ResourcePathPattern.specificity`) l'emporte, puis l'ordre de déclaration ;
4. sinon, si une assignation qui correspond exige une approbation, `require-approval` ;
5. sinon, `deny` avec la raison `no-matching-grant`, comme aujourd'hui.

L'absence d'assignation ne devient jamais une demande d'approbation.

Les limites d'ingénierie déclarées par `mcp-scada` (E1) sont ensuite **intersectées** avec les contraintes retenues. Elles s'appliquent à tous les acteurs ; elles ne font que restreindre. La décision renvoyée est donc complète : `mcp-scada` n'a plus aucune plage dans sa propre configuration.

Pour une trame MCP ordinaire, le broker ne peut ni suspendre un appel ni vérifier une valeur. Une décision `require-approval` ou `allow-with-constraints` y vaut donc `allowed: false`. Seule l'API `broker/authorize` renvoie ces effets, à un provider qui sait les appliquer.

### Hors périmètre de E4

Le **circuit** d'approbation (file des demandes, validation, expiration, révocation) fera l'objet d'un brief séparé. E4 se limite à ce que le moteur décide.

## E5. Audit unique

### Constat

Les fonctions `makeAuthorizationAuditEvent` et `writeAuthorizationAuditEvent` sont exportées par le module interne `authorization/index.ts`, mais pas par la racine du paquet : seuls leurs types le sont. L'écriture se fait en dur sur `console.error`, et les événements ne portent pas de corrélation.

### Proposition

- Le broker audite chaque décision de `broker/authorize`, avec `decisionId`, `correlationId`, `policyVersion` et les attributs reçus (clés sensibles masquées).
- Après exécution, le provider envoie une notification, consommée par le broker et jamais relayée :

```json
{
  "jsonrpc": "2.0",
  "method": "broker/audit/result",
  "params": { "decisionId": "dec_91c2", "result": "success", "nativeStatus": "Good" }
}
```

- Le broker relie ce résultat à sa décision. Une décision d'écriture ou d'appel restée sans résultat au-delà d'un délai configurable est signalée par `broker_diagnose`.
- `correlationId` est repris de `X-Correlation-Id` pour un client HTTP qui l'envoie, généré par le broker sinon (en 1.5.0, toujours généré ; voir E2).
- Un puits d'audit configurable : `WsTunnelBuilder.withAuthorizationAuditSink(sink)`, avec stderr par défaut.

`mcp-scada` n'écrit plus d'audit à lui. Il n'y a qu'une autorité d'audit, comme le demande le §4 du brief SCADA.

## E6. Conditions sur attributs (optionnelle)

Les attributs arrivent désormais au broker par `broker/authorize`. Il devient donc possible de les évaluer, par égalité seulement et sans langage d'expression :

```json
{
  "id": "maintenance-only-writes",
  "subject": "group:maintenance-area-a",
  "role": "scada-operator",
  "resource": "/production/site1/**",
  "when": { "plant.mode": ["maintenance"] }
}
```

**Recommandation : ne pas le faire en v1.** La destination est déjà portée par la capability (`scada.acquire` contre `scada.observe`). À ajouter quand un besoin concret apparaît.

## Limites de débit

Elles protègent les équipements, pas les droits. `mcp-scada` les applique déjà par provider (refus `rate_limited`, sans file d'attente). **Pas d'évolution du broker en v1.** Un quota par acteur prendrait plus tard la forme d'une obligation E4.

## Impact sur mcp-scada

| Aujourd'hui | Après évolution |
|---|---|
| `BrokerPolicyGate` compile sa propre copie du moteur | `BrokerDecisionClient` appelle `broker/authorize` ; plus aucune policy dans le processus |
| Acteur de service unique (`ActorResolver`) | Référence d'appelant lue dans `_meta`, renvoyée telle quelle |
| Plages dans `ScadaService.resources` | Plages déclarées au broker (E1), reçues dans la décision |
| Audit `decision` et `result` écrit par `mcp-scada` | Décision auditée par le broker ; `broker/audit/result` après exécution |
| Slots protocolaires joignables par n'importe quel client | Slots protégés par la déclaration |

Le contrat SCADA v1 vu des clients ne change pas.

## Compatibilité

- Sans déclaration, aucun bloc `_meta` n'est ajouté, aucune méthode `broker/*` n'est utilisée, et toutes les décisions sont identiques à la version 1.4.0.
- Les champs `effect` et `obligations` sont absents tant qu'aucune assignation ne porte d'obligation et qu'aucune limite n'est déclarée.
- **Refus immédiat, jamais de silence.** Un broker 1.4.0 ne relaie pas `broker/authorization/declare` : `_routeFromProvider` prend toute trame provider portant un `id` pour une réponse, n'en trouve aucune en attente, et la **jette** avec un avertissement (`_warnUnmatchedResponseId`). Le provider attend alors une réponse qui ne viendra pas. Attendre une échéance pour conclure à un refus immobiliserait chaque requête SCADA le temps de cette échéance, ce qui ne tient pas la charge. Deux règles :
  - **Broker 1.4.1 (correctif).** Une trame provider qui porte à la fois `id` et `method` et ne correspond à aucune requête en attente reçoit immédiatement une erreur JSON-RPC `-32601 Method not found`, renvoyée au provider avec son `id`. Le même correctif lève le blocage silencieux actuel des requêtes `sampling/createMessage`, `roots/list` et `elicitation/create`. À partir de 1.5.0, une méthode `broker/*` inconnue ou refusée est aussi refusée immédiatement (E1).
  - **mcp-scada.** Une erreur reçue à la déclaration vaut refus : `mcp-scada` ne sert aucune opération. Un délai d'attente reste possible pour un broker antérieur à 1.4.1, mais il est **désactivé par défaut** et ne s'active que par configuration explicite. Le chemin normal ne dépend jamais d'une échéance.

## Lotissement proposé

| Lot | Contenu | Version visée |
|---|---|---|
| 0 | Refus immédiat `-32601` d'une requête provider sans destinataire ; refus de démarrer quand le fichier de configuration désigné ne se lit pas (au lieu de repartir sur `{}`) | broker 1.4.1 |
| 1 + 2 | Livrés ensemble. Espace réservé `broker/*` avec refus immédiat ; E2 (référence d'appelant ancrée sur `brokerId`, injection par `AggregateServer`, suppression anti-usurpation) ; `IMcpRequestContext` sur outils, ressources et prompts ; E1 (déclaration, double identifiant `resource` / `resourcePath`, table `providers`, fichier de sécurité séparé, `protectedSlots` fermés dès le démarrage, protection côté publication et prise de place) ; E3 (`broker/authorize`) ; client côté provider | mcp-core 1.4.0 (publié), broker 1.5.0, provider 0.3.0 |
| 3 | E5 (audit unique, `broker/audit/result`, puits configurable, reprise de `X-Correlation-Id`) ; signature du fichier de sécurité | broker 1.5.x |
| 4 | E4 (obligations sur les assignations, limites intersectées) | broker 1.6.0 |
| 5 | E6, si un besoin est établi | à décider |

Les lots 1 à 3 rendent le broker seul décideur pour `observe` et `acquire`, et mettent fin à l'acteur de service unique. Le lot 4 ouvre `control` et `execute` aux opérateurs avec leurs contraintes.

## Tests d'acceptation

| # | Test |
|---|---|
| T1 | Une requête client contenant `_meta["io.cyanmycelium/caller"]` arrive au provider sans cette clé, quel que soit le slot. |
| T2 | Une référence d'appelant est refusée après la réponse à sa requête, sur un autre slot, ou par un autre provider. |
| T3 | `broker/authorize` refuse un `principal` de type inconnu, portant une identité en clair, ou mélangeant `provider` et `ref`. |
| T4 | `broker/authorize` sur une ressource hors de l'espace déclaré renvoie `deny` / `undeclared-resource`. |
| T5 | Une déclaration contenant `assignments`, `roles`, `denies`, `*` ou une capability hors du domaine est refusée en entier. |
| T6 | Une déclaration venant d'un provider anonyme, ou dont l'espace sort de ses `allowedResources`, est refusée. |
| T7 | Un slot protégé refuse un client ordinaire, accepte le principal du provider déclarant, n'apparaît plus dans `_all`, et le reste après une déconnexion de ce provider. |
| T8 | Sans déclaration, les trames et les décisions sont identiques à celles de la version 1.4.0. |
| T9 | Un adapter `mcp-core` écrit pour la version 1.3.0 fonctionne sans modification. |
| T10 | Un deny explicite l'emporte sur une assignation avec obligations ; une assignation sans obligation l'emporte sur une assignation contrainte. |
| T11 | Une limite d'ingénierie déclarée restreint la contrainte d'une assignation et ne l'élargit jamais. |
| T12 | Une décision `require-approval` sur une trame MCP ordinaire vaut un refus. |
| T13 | Un `decisionId` relie dans l'audit du broker la requête, la décision et le résultat natif ; une écriture sans résultat est signalée par `broker_diagnose`. |
| T14 | Une requête provider sans destinataire, ou une méthode `broker/*` inconnue ou refusée, reçoit une erreur JSON-RPC immédiate, sans attendre aucune échéance. |
| T15 | Un appel SCADA passé par `_all` arrive au provider avec une référence d'appelant valide, et une clé `io.cyanmycelium/caller` envoyée par le client à `_all` est supprimée. |
| T16 | Un slot listé dans `protectedSlots` est fermé dès le démarrage du broker, avant toute déclaration ; un provider autre que `publishedBy` ne peut ni y publier ni en prendre la place. |
| T17 | Un `resourcePath` hors de `namespace.resource`, absent, ou contenant un segment `..`, vide ou `%2F`, est refusé à la déclaration et reçoit `deny` / `undeclared-resource` dans `broker/authorize`. |
| T22 | Une question qui présente l'identifiant natif d'une ressource déclarée avec un autre `resourcePath` que celui de la déclaration est refusée. |
| T18 | Une assignation absente ne produit jamais `require-approval` : sans assignation qui correspond, la décision est `deny` / `no-matching-grant`. |
| T19 | Un fichier de sécurité désigné mais absent, mal formé, ou dont la signature est invalide alors qu'une clé est configurée, empêche le démarrage du broker. Un `config.json` désigné et illisible l'empêche aussi (1.4.1). |
| T20 | `protectedSlots` placé dans `config.json` est refusé ; des sections `auth` / `authorization` dans `config.json` en même temps qu'un fichier de sécurité empêchent le démarrage. |
| T21 | Modifier le fichier de sécurité change `policyVersion`, visible dans `broker_info` et dans chaque décision auditée. |

## Questions ouvertes

1. Les administrateurs SCADA doivent-ils pouvoir écrire des **assignations** depuis un outil SCADA ? Si oui, cela passe par une API d'administration du broker appelée par un acteur administrateur authentifié, jamais par la déclaration du provider.
2. Faut-il signer la référence d'appelant pour les providers distants, ou la confiance dans le transport authentifié suffit-elle ?
3. La règle « la plus spécifique l'emporte » entre assignations contraintes convient-elle aux exploitants, ou faut-il une priorité explicite ?
4. Où vit le circuit d'approbation : dans le broker, ou dans un service dédié qui interroge le broker ?
5. Au-delà des `protectedSlots` du fichier de sécurité (tranché en E1), le reste de la déclaration (ressources, limites) doit-il être persisté par le broker, ou suffit-il que `mcp-scada` le renvoie à sa reconnexion, les opérations restant refusées d'ici là ?
