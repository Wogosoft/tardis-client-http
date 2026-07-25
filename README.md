# @wogo/tardis-client-http

Auto generated client that communicates to TARDIS via HTTP

## Usage

```ts
import { 
    Tardis,
    RuntimeServiceMap,
    makeServiceMapFromEffect
} from "@wogo/tardis-client-http";
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

// 1. Build the ServiceMap
const URLLayer = Effect.succeed(RuntimeServiceMap.of({
    UserAuthenticatorService: "https://www.google.com"
})).pipe(makeServiceMapFromEffect)

// 2. Use the Service
const program = Effect.gen(function*(){
    const auth = yield* Tardis.UserAuthenticatorService
    const response = yield* auth.login({
        username: "wogo",
        password: "*****"
    })
    yield* Effect.log(response);
})

// 3. Provide the needed layers
program.pipe(
	Effect.provide(Tardis.UserAuthenticatorService.layer),
    Effect.provide(URLLayer),
    Effect.provide(FetchHttpClient.layer),
    Effect.runPromise
)
```