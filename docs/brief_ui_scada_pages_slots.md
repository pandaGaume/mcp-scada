# Interface SCADA servie par le broker, et pages web comme slots

Date : 1er octobre 2026
Base : `@cyanmycelium/mcp-broker` 1.5.0 (sur `main`, non publié), `@cyanmycelium/mcp-broker-provider` 0.3.0 (idem), `@cyanmycelium/mcp-core` 1.4.0
Origine : [évolution du broker pour SCADA v1](brief_evolution_mcp_broker_scada.md) (E1 à E5)

## Décision proposée

L'interface SCADA est une **page web servie par le broker**, par un montage statique. Son code vit dans `mcp-scada` (dossier `www/`) ; le broker sert des fichiers sans rien savoir de SCADA.

La page parle MCP dans les deux sens :

- comme **client** de `_broker`, pour voir l'autorisation du domaine SCADA, et du slot `scada`, pour agir en opérateur ;
- comme **provider** : elle publie elle-même des slots depuis le navigateur (équipements simulés, opérateurs scriptés, plus tard le circuit d'approbation).

**Exigence non négociable : toute page qui publie un slot est authentifiée.** Servir des slots depuis des pages web est un des gros avantages du broker ; ce n'est acceptable que si le broker sait qui publie. Le mécanisme définitif (option C, token OAuth) est à intégrer dans `mcp-broker` dès que possible. Un mécanisme temporaire (option A, secret en sous-protocole WebSocket) débloque les tests en attendant ; il est signalé comme tel partout.

## Pourquoi le broker sert la page

| | page servie par le broker | page servie par `mcp-scada` |
|---|---|---|
| Serveur HTTP dans `mcp-scada` | aucun | à ajouter, avec TLS, origines et authentification |
| Une seule origine pour la page, `_broker` et le slot `scada` | oui | non, CORS et deux listes d'origines |
| La page peut être un slot du même broker | naturellement | possible, mais par un second chemin |
| Le broker connaît SCADA | non, il sert des fichiers | non |

Configuration côté broker :

```json
{
  "www": { "mounts": [{ "urlPrefix": "/scada", "dir": "/opt/mcp-scada/www" }] },
  "allowedOrigins": ["https://broker.site1.example.com"]
}
```

Un montage statique ne dispense pas l'origine qu'il sert de la liste `allowedOrigins` ; `broker_diagnose` le signale déjà (`self-served-page-blocked`).

## Ce que la page montre

Le broker ne lit jamais les arguments des outils SCADA. La page ne montre donc, venant du broker, que **l'autorisation** du domaine ; les valeurs du procédé, le `browse` de l'UNS et les écritures viennent du slot `scada`, comme pour n'importe quel client.

Les vues sont construites comme une **vue de domaine paramétrée** (`scada` est le premier domaine) : le broker reste agnostique, et un autre domaine aurait les mêmes vues sans code nouveau.

### V1. État du domaine

En-tête toujours visible :

- déclaration : acceptée ou non, par quel principal, en quelle version, avec quelle `policyVersion`, depuis quand ;
- provider du domaine connecté ou non ;
- pour chaque slot protégé : confirmé par la déclaration, provider `publishedBy` connecté.

Répond à : « la chaîne SCADA est-elle debout, et les slots protocolaires sont-ils bien fermés ? »

### V2. Droits sur l'UNS

- l'arbre des ressources déclarées, avec leur effet (`physical-action`) et leurs limites d'ingénierie ;
- pour une ressource sélectionnée, une ligne par capability (`observe`, `acquire`, `control`, `execute`) : les assignations qui l'accordent, les denies qui l'emportent.

Calculé depuis la policy, sans simuler un utilisateur. Répond à : « qui peut piloter la consigne de motor01 ? »

### V3. Décisions

Le fil des `broker/authorize` du domaine : heure, sujets, capability, ressource native (`uns://...`), effet, raison, règles qui ont joué, `correlationId`, et avec le lot 3 de l'évolution (E5) le résultat natif et le signalement d'une écriture autorisée restée sans résultat. Filtres par sous-arbre, sujet, effet.

Répond à : « pourquoi l'opérateur X a-t-il été refusé ? », « qui a écrit quoi, l'automate a-t-il répondu ? »

### Hors du minimum

- les approbations en attente : elles arrivent avec E4, sous forme de page-slot (voir plus bas) ;
- toute modification de la policy : elle vit dans le fichier de sécurité, sous la main des administrateurs du broker. La page est en lecture seule pour l'autorisation.

## Ce que le broker doit exposer

Des **ressources MCP sur `_broker`**, que la page lit comme n'importe quel client (et qu'un agent peut lire aussi) :

| ressource | vue | dépend de |
|---|---|---|
| `broker://domains/{domain}` | V1 | E1 (fait) ; il manque l'exposition |
| `broker://domains/{domain}/rights?resource=<chemin>` (ou un outil `broker_domain_rights`) | V2 | une méthode d'introspection du moteur : « quelles règles correspondent à ce chemin et cette capability », sans sujet |
| `broker://domains/{domain}/decisions`, avec `resources/subscribe` | V3 | E5 : un puits d'audit en tampon circulaire |

Ces ressources ne disent rien de plus que ce qu'un administrateur lirait dans le fichier de sécurité et l'audit, mais elles le disent à travers la policy :

- `broker.authority.read` pour V1 et V2 ;
- `broker.audit.read` pour V3 ;
- assignées sur des chemins, comme le reste : un superviseur avec `broker.audit.read` sur `/production/site1/line1/**` ne voit que les décisions de la ligne 1. Aucune règle nouvelle, c'est le moteur actuel.

## La page comme slot

### Cas d'usage

- **Équipement simulé** : la page publie un faux `bench-motor01` (`modbus.read`, `modbus.write`). La chaîne entière (décisions, slots protégés, limites) se teste sans automate.
- **Opérateurs scriptés** : plusieurs onglets, chacun avec son identité, rejouent un scénario (un opérateur autorisé, un visiteur refusé, un deny explicite).
- **Défaillances** : un équipement qui ne répond pas, qui répond hors limites, qui se déconnecte au milieu d'une écriture. Nécessaire pour éprouver l'écriture sans résultat de E5.
- **Circuit d'approbation (E4)** : une page superviseur publiée comme slot reçoit les demandes `require-approval` et y répond. Réponse candidate à la question ouverte 4 de l'évolution (où vit le circuit d'approbation).

### Le problème

Le secret d'un provider part dans un en-tête de handshake (`X-Provider-Token`), et le `WebSocket` d'un navigateur ne peut pas en envoyer. Dès que le broker authentifie les providers, ce qu'exigent les slots protégés et les déclarations, une page est refusée. Aujourd'hui une page ne peut publier que sur un broker sans authentification des providers, c'est-à-dire précisément pas dans la configuration à tester.

Deuxième trou, lié : la mise à niveau WebSocket n'a **aucun contrôle d'origine** (anti-objectif documenté dans `AGENTS.md`). Toute page de n'importe quel site, ouverte sur un poste qui atteint le broker, peut tenter d'ouvrir un socket provider.

### Option A : secret en sous-protocole WebSocket (TEMPORAIRE)

La page ouvre :

```js
new WebSocket(url, ["mcp-provider", "mcp-provider-secret." + base64url(secret)])
```

- Le broker lit `Sec-WebSocket-Protocol`, authentifie le secret contre la table `providers` comme il le fait pour `X-Provider-Token`, et **renvoie seulement `mcp-provider`** (le navigateur exige qu'une des valeurs offertes soit renvoyée ; le secret ne l'est jamais).
- Le secret est encodé en base64url : un sous-protocole n'admet que les caractères d'un `token` HTTP.
- Côté `@cyanmycelium/mcp-broker-provider`, l'option `secret` existante choisit le canal : en-tête sous Node, sous-protocole dans un navigateur.

**Marqué temporaire, partout :**

- désactivé par défaut ; activé par une clé explicite du fichier de sécurité (`"providerAuth": { "allowBrowserSecrets": true }`) ;
- la bannière de démarrage et `broker_diagnose` (note de sévérité `warning`) le signalent tant qu'il est actif ;
- la documentation le présente comme un mécanisme de transition, à retirer quand C est livré, et dit pourquoi : un secret présent dans le JavaScript d'une page appartient à quiconque charge cette page. Il ne convient qu'au développement, aux tests et à un poste de confiance.

### Option C : token OAuth de l'utilisateur (CIBLE, dès que possible)

La page est déjà authentifiée comme client : elle obtient un token par le flux PKCE (celui de l'OAuth lab). Pour publier, elle présente un token du même serveur d'autorisation, par le même canal que A (`Sec-WebSocket-Protocol`, valeur `mcp-provider-bearer.<jwt>`), et non plus un secret partagé.

- **Audience** : le token est émis pour la ressource du point d'entrée provider (`<publicBaseUrl>/provider/<slot>`, ou `/providers` pour le multiplex), et non pour un slot client. Un token client ne permet pas de publier, et inversement.
- **Identité** : une entrée de la table `providers` déclare quels sujets peuvent publier sous son identité :

```json
{
  "providers": [
    {
      "id": "scada-supervisor-page",
      "tokenSubjects": ["group:shift-supervisors"],
      "subjects": ["service:scada-supervisor-page"],
      "allowedResources": ["/production/site1/approvals/**"]
    }
  ]
}
```

  Une page dont le token donne un sujet de `tokenSubjects` est authentifiée comme `scada-supervisor-page`. Une même entrée peut accepter un secret (`secretEnv`, pour un provider Node) ou des tokens, ou les deux.
- **Audit** : chaque publication, déclaration et décision demandée par une page enregistre le principal provider **et** l'humain derrière (`sub` du token). Une approbation donnée par une page dit qui l'a donnée.
- **Expiration** : le broker ferme le socket provider à l'`exp` du token (`1008`, raison « token expired, reconnect with a fresh one »). Un renouvellement sans coupure (`broker/reauthenticate`) peut venir plus tard.
- **Origine** : un socket provider qui porte un en-tête `Origin` (c'est-à-dire un navigateur) n'est accepté que si cette origine figure dans `allowedOrigins`. Ferme le second trou pour les pages, sans changer le comportement des providers Node, qui n'envoient pas d'`Origin`.
- **Sans OAuth configuré**, l'option C n'existe pas : un broker sans serveur d'autorisation n'a que A, temporaire, ou des providers Node.

## Kit de test

`startTestBroker()` accepte un montage statique, et l'option A (puis C) avec ses tokens de test :

```ts
const broker = await startTestBroker({
    callers: { supervisor: { groups: ["shift-supervisors"] } },
    providers: { "bench-sim": { allowedResources: ["/production/site1/bench/**"] } },
    www: { "/scada": "../www" },
});
```

Un test Playwright ouvre alors la vraie page SCADA servie par un vrai broker, avec équipements simulés et opérateurs scriptés, sans autre infrastructure.

## Lotissement proposé

| Lot | Contenu | Paquets |
|---|---|---|
| P1 | Option A (sous-protocole, désactivée par défaut, signalée temporaire) ; contrôle d'origine sur les sockets provider venant d'un navigateur ; option `secret` du provider en sous-protocole dans un navigateur ; montage `www` dans le kit de test | broker, provider |
| P2 | Option C (tokens OAuth pour publier, `tokenSubjects`, audience provider, fermeture à `exp`, audit de l'humain) ; A reste disponible derrière son drapeau | broker, provider |
| P3 | `broker://domains/{domain}` et les droits (V1, V2), capability `broker.authority.read` ; page `mcp-scada/www` avec V1 et V2 et un équipement simulé | broker, mcp-scada |
| P4 | Avec E5 : `broker://domains/{domain}/decisions`, `broker.audit.read`, vue V3 | broker, mcp-scada |
| P5 | Avec E4 : la page superviseur comme slot d'approbation | broker, mcp-scada |
| P6 | Retrait de A, une fois C en place partout où des pages publient | broker, provider |

P2 suit P1 sans attendre les vues : c'est C qui rend les pages-slots acceptables hors des tests.

## Tests d'acceptation

| # | Test |
|---|---|
| U1 | Sans `allowBrowserSecrets`, un socket provider qui présente un secret en sous-protocole est refusé ; avec, il est authentifié comme l'entrée correspondante, et le broker ne renvoie que `mcp-provider`. |
| U2 | Tant que A est actif, la bannière et `broker_diagnose` le signalent. |
| U3 | Un socket provider portant un `Origin` absent de `allowedOrigins` est refusé ; un socket sans `Origin` (Node) n'est pas affecté. |
| U4 | Une page avec un token dont un sujet figure dans `tokenSubjects` publie sous l'identité de l'entrée ; un token client (audience d'un slot) ne permet pas de publier. |
| U5 | Le socket d'une page est fermé en `1008` à l'expiration de son token. |
| U6 | Une déclaration ou une décision demandée par une page enregistre dans l'audit le principal provider et le `sub` de l'humain. |
| U7 | `broker://domains/scada` donne la déclaration, l'état du provider et des slots protégés ; sans `broker.authority.read` sur le chemin, la ressource est refusée. |
| U8 | Un superviseur avec `broker.audit.read` sur `/production/site1/line1/**` ne reçoit que les décisions de ce sous-arbre. |
| U9 | Une page servie par le kit de test publie un équipement simulé dans un slot protégé dont elle est `publishedBy`, et le scénario opérateur autorisé / visiteur refusé passe de bout en bout. |

## Questions ouvertes

1. Le chemin de montage de la page (`/scada`) doit-il être réservé, pour qu'aucun slot ne porte ce nom et ne masque les fichiers ?
2. Pour C, faut-il un renouvellement de token sans coupure dès P2, ou la fermeture à `exp` suffit-elle tant que les tokens durent quelques heures ?
3. La vue V2 doit-elle pouvoir évaluer pour un sujet donné (« que peut faire Alice ici ? »), ce qui en fait un simulateur de policy, ou rester une liste de règles ?
4. Une page qui publie un slot et qui est fermée par l'utilisateur : le slot disparaît. Faut-il une notion de slot « attendu » dont l'absence est signalée par `broker_diagnose` ?
