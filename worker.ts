/// <reference types="@cloudflare/workers-types" />
import {ResultAsync, okAsync, errAsync} from "neverthrow";
import { z, ZodError } from "zod";
import * as Errors from "./errors";
import {ErrorRes} from "./errors";


/**** EXPECTED DATA STRUCTURES ****/ 
interface env {
	DB: D1Database;
	GOOGLE_CLIENT_ID: string;
	CACHE_VERSIONS: KVNamespace;
}

const googleTokenSchema = z.object({
	iss: z.string(),
	aud: z.string(),
	sub: z.string(),
	email: z.email().optional(),
	email_verified: z.enum(["true", "false"]).optional(),
	name: z.string().optional(),
	picture: z.url().optional(),
	iat: z.coerce.number(),
	exp: z.coerce.number(),
});



const resultsSchema = z.object({
	swimmer_id: z.coerce.number().int(),
	event_id: z.coerce.number().int(),
	meet_id: z.coerce.number().int(),
	time_ms: z.coerce.number(),
	is_valid: z.coerce.boolean(),
	invalid_reason: z.string().nullable(),
});

const relayLegSchema = z.object({
	relay_id: z.coerce.number().int(),
	swimmer_id: z.coerce.number().int(),
	event_id: z.coerce.number().int(),
	leg_order: z.coerce.number().int(),
	split_time: z.coerce.number(),
	is_valid: z.coerce.boolean(), 
	invalid_reason: z.string().nullable(),
});

const relaySchema = z.object({
	event_id: z.coerce.number().int(),
	meet_id: z.coerce.number().int(),
	time_ms: z.coerce.number(),
	is_valid: z.coerce.boolean(), 
	invalid_reason: z.string().nullable()
});

export const swimmerSchema = z.object({
	first_name: z.string(),
	last_name: z.string(),
	gender: z.enum(['male', 'female']),
	graduating: z.coerce.number().int()
});

export const meetSchema = z.object({
	name: z.string(),
	location: z.string(),
	date: z.string()
});

/**** VARIOUS UTILITIES ****/ 
function zodErrorToHumanReadable(err: ZodError): string {
	return err.issues
		.map(i => `${i.path.join(".")}: ${i.message}`)
		.join("; ");
}

function zodParseWith<T>(
	schema: z.ZodSchema<T>, 
	errFunc: (errMsg: string) => ErrorRes
): (json: unknown) => ResultAsync<T, ErrorRes> {
	return (json: unknown) => {
		const parseResult = schema.safeParse(json);
		if (!parseResult.success) {
			return errAsync(errFunc(zodErrorToHumanReadable(parseResult.error)));
		}
		return okAsync(parseResult.data);
	};
}

function queryDB(
	db: D1Database,
	query: string, 
	errFunc: (errMsg: string) => ErrorRes = (e: string) => new Errors.InternalDatabase(`Failed to query database: ${e}`),
	binds: any[] = []
): ResultAsync<Response, ErrorRes> {
	return ResultAsync.fromPromise(
		db.prepare(query).bind(...binds).all(),
		(e) => {console.error("D1 error: ", e); return errFunc(JSON.stringify(e))}
	).map((res) => returnJSONResponse(res));
}

function queryDBBatched(
	db: D1Database,
	queries: { query: string, binds?: any[] }[],
	errFunc: (errMsg: string) => ErrorRes = (e: string) => new Errors.InternalDatabase(`Failed to query database: ${e}`)
): ResultAsync<D1Result[], ErrorRes> {
	const preparedQueries = queries.map(q => db.prepare(q.query).bind(...(q.binds ?? [])));
	return ResultAsync.fromPromise(
		db.batch(preparedQueries),
		(e) => {console.error("D1 error: ", e); return errFunc(JSON.stringify(e))}
	);
}

function returnJSONResponse(data: any, status: number = 200): Response {
	return new Response(JSON.stringify(data.results), {
		status: status,
		headers: { "Content-Type": "application/json" }
	});
}

function getRequestJSON(
	request: Request, 
	errFunc: (errMsg: string) => ErrorRes = (e: string) => new Errors.MalformedRequest(`Failed to parse request JSON: ${e}`)
): ResultAsync<any, ErrorRes> {
	return ResultAsync.fromPromise(
		request.json(),
		(e) => errFunc(JSON.stringify(e))
	);
}

function getAndParseRequestJSON<T>(
	request: Request, 
	schema: z.ZodSchema<T>, 
	errFunc: (errMsg: string) => ErrorRes = (e: string) => new Errors.MalformedRequest(`Failed to parse request JSON: ${e}`)
): ResultAsync<T, ErrorRes> {
	return getRequestJSON(request, errFunc).andThen(zodParseWith(schema, errFunc));
}

const CACHE_TTL = 60 * 30; // 30 min
export function cachedQuery(
	request: Request,
	env: env,
	ctx: ExecutionContext,
	key: string,
	query: string
): ResultAsync<Response, ErrorRes> {
	const cache = (caches as any).default as Cache;

	return ResultAsync.fromPromise(
		env.CACHE_VERSIONS.get(key),
		(e) => new Errors.InternalDatabase(String(e))
	).andThen((version) => {
		if (!version) {
			const newVersion = Date.now().toString();
			ctx.waitUntil(env.CACHE_VERSIONS.put(key, newVersion));
			return okAsync(newVersion);
		}
		return okAsync(version);
	}).andThen((version) => {
		const cacheKey = new Request(`${request.url}?v=${version}`, request);

		return ResultAsync.fromPromise(
			cache.match(cacheKey),
			(e) => new Errors.InternalDatabase(String(e))
		).andThen((cached) => {
			if (cached) {
				return okAsync(cached);
			}

			return queryDB(env.DB, query).andThen((response) => {
				const newResponse = new Response(response.body, {
					status: response.status,
					headers: {
						...Object.fromEntries(response.headers),
						"Cache-Control": `public, max-age=${CACHE_TTL}`,
					},
				});

				ctx.waitUntil(cache.put(cacheKey, newResponse.clone()));

				return okAsync(newResponse);
			});
		});
	});
}

export function invalidateCacheKey(
	env: env,
	ctx: ExecutionContext,
	key: string
): ResultAsync<void, never> {
	return okAsync(undefined).map(() => {
		const newVersion = Date.now().toString();
		ctx.waitUntil(env.CACHE_VERSIONS.put(key, newVersion));
	});
}

/**** MAIN ROUTING ****/
const routes: Record<string, (request: Request, env: env, ctx: ExecutionContext) => ResultAsync<Response, ErrorRes>> = {


		"POST /invalidate_cache": (request, env, ctx) => verifyAuth(request, env).andThen(() => {
			invalidateCacheKey(env, ctx, "meets");
			invalidateCacheKey(env, ctx, "results");
			invalidateCacheKey(env, ctx, "events");
			invalidateCacheKey(env, ctx, "swimmers");
			invalidateCacheKey(env, ctx, "records");
			invalidateCacheKey(env, ctx, "relay_legs");
			invalidateCacheKey(env, ctx, "relays");
			return okAsync(new Response("Cache invalidated"));
		}),
		"GET /meets": (req, env, ctx) =>
		  cachedQuery(req, env, ctx, "meets", `
			SELECT * FROM meets ORDER BY date DESC
		  `),

		"GET /results": (req, env, ctx) =>
		  cachedQuery(req, env, ctx, "results", `
			SELECT * FROM results
		  `),

		"GET /events": (req, env, ctx) =>
		  cachedQuery(req, env, ctx, "events", `
			SELECT * FROM events
		  `),

		"GET /swimmers": (req, env, ctx) =>
		  cachedQuery(req, env, ctx, "swimmers", `
			SELECT * FROM swimmers
		  `),

	"GET /records": (req, env, ctx) => cachedQuery(req,env,ctx,"records",
  `
    SELECT rp.*
    FROM record_progressions rp
    JOIN meets m ON rp.meet_id = m.id
    ORDER BY m.date ASC, rp.time_ms DESC, rp.id ASC
  `
),

	
	"GET /relay_legs": (req, env, ctx) => cachedQuery(req,env,ctx,"relay_legs",`
		SELECT * from relay_legs
	`),

	
	"GET /relays": (req, env, ctx) => cachedQuery(req,env, ctx, "relays",`
		SELECT * from relays
	`),
			
	
	"POST /results": (request, env, ctx) => verifyAuth(request, env)
	.andThen(() =>
		getAndParseRequestJSON(
			request,
			resultsSchema,
			(errMsg) => new Errors.MalformedRequest("Given invalid result data: " + errMsg),
		),
	)
	.andThen((json) =>
		queryDBBatched(
			env.DB,
			[
  {
    query: `
INSERT INTO results (swimmer_id, event_id, meet_id, time_ms, is_valid, invalid_reason)
VALUES (?, ?, ?, ?, ?, ?)`,
    binds: [
      json.swimmer_id,
      json.event_id,
      json.meet_id,
      json.time_ms,
      json.is_valid,
      json.invalid_reason,
    ],
  },

  // --- delete personal record progression for this swimmer/event
  {
    query: `
DELETE FROM record_progressions
WHERE school_record = 0 AND type = 'individual'
  AND swimmer_id = ? AND event_id = ?`,
    binds: [json.swimmer_id, json.event_id],
  },

  // --- delete all SCHOOL record progression for this event
  {
    query: `
DELETE FROM record_progressions
WHERE school_record = 1 AND type = 'individual'
  AND event_id = ?`,
    binds: [json.event_id],
  },

  // --- rebuild individual PR progression (includes relay leg 1)
  {
    query: `
INSERT INTO record_progressions (school_record, type, swimmer_id, relay_id, event_id, result_id, meet_id, leg_id, time_ms)
SELECT 0, 'individual', swimmer_id, null, event_id, result_id, meet_id, leg_id, time_ms
FROM (
  SELECT *,
         MIN(time_ms) OVER (
           PARTITION BY swimmer_id, event_id
           ORDER BY date, time_ms, id
         ) AS running_best
  FROM (
    SELECT r.id,
           r.swimmer_id,
           r.event_id,
           r.meet_id,
           r.time_ms,
           r.id AS result_id,
           NULL AS leg_id,
           m.date
    FROM results r
    JOIN meets m ON r.meet_id = m.id
    WHERE r.is_valid = 1

    UNION ALL

    SELECT rl.id,
           rl.swimmer_id,
           rl.event_id,
           rel.meet_id,
           rl.split_time AS time_ms,
           NULL AS result_id,
           rl.id AS leg_id,
           m.date
    FROM relay_legs rl
    JOIN relays rel ON rl.relay_id = rel.id
    JOIN meets m ON rel.meet_id = m.id
    WHERE rl.is_valid = 1
      AND rl.leg_order = 1
  )
)
WHERE time_ms = running_best
  AND swimmer_id = ?
  AND event_id = ?`,
    binds: [json.swimmer_id, json.event_id],
  },

  // --- rebuild individual SCHOOL record progression (global per event)
  {
    query: `
INSERT INTO record_progressions (school_record, type, swimmer_id, relay_id, event_id, result_id, meet_id, leg_id, time_ms)
SELECT 1, 'individual', swimmer_id, null, event_id, result_id, meet_id, leg_id, time_ms
FROM (
  SELECT *,
         MIN(time_ms) OVER (
           PARTITION BY event_id
           ORDER BY date, time_ms, id
         ) AS running_best
  FROM (
    SELECT r.id,
           r.swimmer_id,
           r.event_id,
           r.meet_id,
           r.time_ms,
           r.id AS result_id,
           NULL AS leg_id,
           m.date
    FROM results r
    JOIN meets m ON r.meet_id = m.id
    WHERE r.is_valid = 1

    UNION ALL

    SELECT rl.id,
           rl.swimmer_id,
           rl.event_id,
           rel.meet_id,
           rl.split_time AS time_ms,
           NULL AS result_id,
           rl.id AS leg_id,
           m.date
    FROM relay_legs rl
    JOIN relays rel ON rl.relay_id = rel.id
    JOIN meets m ON rel.meet_id = m.id
    WHERE rl.is_valid = 1
      AND rl.leg_order = 1
  )
)
WHERE time_ms = running_best
  AND event_id = ?`,
    binds: [json.event_id],
  },
],
			(e) => new Errors.InternalDatabase(`Results database insertion failed: ${e}`),
		),
	)
	.andThen(() => invalidateCacheKey(env, ctx, "results"))
	.map(() => new Response("Result successfully added", { status: 201 })),	
	
	"POST /relay_legs": (request, env, ctx) => verifyAuth(request, env)
	.andThen(() =>
		getAndParseRequestJSON(
			request,
			relayLegSchema,
			(errMsg) => new Errors.MalformedRequest("Given invalid relay leg data: " + errMsg),
		),
	)
	.andThen((json) =>
		queryDBBatched(
			env.DB,
			[
  {
    query: `
INSERT INTO relay_legs (relay_id, swimmer_id, event_id, leg_order, split_time, is_valid, invalid_reason)
VALUES (?, ?, ?, ?, ?, ?, ?)`,
    binds: [
      json.relay_id,
      json.swimmer_id,
      json.event_id,
      json.leg_order,
      json.split_time,
      json.is_valid,
      json.invalid_reason,
    ],
  },

  // --- delete personal record progression (individual)
  {
    query: `
DELETE FROM record_progressions
WHERE school_record = 0 AND type = 'individual'
  AND swimmer_id = ? AND event_id = ?`,
    binds: [json.swimmer_id, json.event_id],
  },

  // --- delete school record progression (individual)
  {
    query: `
DELETE FROM record_progressions
WHERE school_record = 1 AND type = 'individual'
  AND event_id = ?`,
    binds: [json.event_id],
  },

  // --- delete personal record progression (relay_leg)
  {
    query: `
DELETE FROM record_progressions
WHERE school_record = 0 AND type = 'relay_leg'
  AND swimmer_id = ? AND event_id = ?`,
    binds: [json.swimmer_id, json.event_id],
  },

  // --- delete school record progression (relay_leg)
  {
    query: `
DELETE FROM record_progressions
WHERE school_record = 1 AND type = 'relay_leg'
  AND event_id = ?`,
    binds: [json.event_id],
  },

  // --- rebuild individual PR progression (includes relay leg 1)
  {
    query: `
INSERT INTO record_progressions (school_record, type, swimmer_id, relay_id, event_id, result_id, meet_id, leg_id, time_ms)
SELECT 0, 'individual', swimmer_id, null, event_id, result_id, meet_id, leg_id, time_ms
FROM (
  SELECT *,
         MIN(time_ms) OVER (
           PARTITION BY swimmer_id, event_id
           ORDER BY date, time_ms, id
         ) AS running_best
  FROM (
    SELECT r.id,
           r.swimmer_id,
           r.event_id,
           r.meet_id,
           r.time_ms,
           r.id AS result_id,
           NULL AS leg_id,
           m.date
    FROM results r
    JOIN meets m ON r.meet_id = m.id
    WHERE r.is_valid = 1

    UNION ALL

    SELECT rl.id,
           rl.swimmer_id,
           rl.event_id,
           rel.meet_id,
           rl.split_time AS time_ms,
           NULL AS result_id,
           rl.id AS leg_id,
           m.date
    FROM relay_legs rl
    JOIN relays rel ON rl.relay_id = rel.id
    JOIN meets m ON rel.meet_id = m.id
    WHERE rl.is_valid = 1
      AND rl.leg_order = 1
  )
)
WHERE time_ms = running_best
  AND swimmer_id = ?
  AND event_id = ?`,
    binds: [json.swimmer_id, json.event_id],
  },

  // --- rebuild individual SCHOOL record progression
  {
    query: `
INSERT INTO record_progressions (school_record, type, swimmer_id, relay_id, event_id, result_id, meet_id, leg_id, time_ms)
SELECT 1, 'individual', swimmer_id, null, event_id, result_id, meet_id, leg_id, time_ms
FROM (
  SELECT *,
         MIN(time_ms) OVER (
           PARTITION BY event_id
           ORDER BY date, time_ms, id
         ) AS running_best
  FROM (
    SELECT r.id,
           r.swimmer_id,
           r.event_id,
           r.meet_id,
           r.time_ms,
           r.id AS result_id,
           NULL AS leg_id,
           m.date
    FROM results r
    JOIN meets m ON r.meet_id = m.id
    WHERE r.is_valid = 1

    UNION ALL

    SELECT rl.id,
           rl.swimmer_id,
           rl.event_id,
           rel.meet_id,
           rl.split_time AS time_ms,
           NULL AS result_id,
           rl.id AS leg_id,
           m.date
    FROM relay_legs rl
    JOIN relays rel ON rl.relay_id = rel.id
    JOIN meets m ON rel.meet_id = m.id
    WHERE rl.is_valid = 1
      AND rl.leg_order = 1
  )
)
WHERE time_ms = running_best
  AND event_id = ?`,
    binds: [json.event_id],
  },

  // --- rebuild relay_leg PR progression (legs 2–4)
  {
    query: `
INSERT INTO record_progressions (school_record, type, swimmer_id, relay_id, event_id, result_id, meet_id, leg_id, time_ms)
SELECT 0, 'relay_leg', swimmer_id, null, event_id, null, meet_id, id, split_time
FROM (
  SELECT *,
         MIN(split_time) OVER (
           PARTITION BY r.swimmer_id, r.event_id
           ORDER BY m.date, r.split_time, r.id
         ) AS running_best
  FROM relay_legs AS r
  JOIN relays as rel ON r.relay_id = rel.id
  JOIN meets as m ON rel.meet_id = m.id
  WHERE r.is_valid = 1
    AND r.leg_order != 1
) 
WHERE split_time = running_best
  AND swimmer_id = ?
  AND event_id = ?`,
    binds: [json.swimmer_id, json.event_id],
  },

  // --- rebuild relay_leg SCHOOL record progression (legs 2–4)
  {
    query: `
INSERT INTO record_progressions (school_record, type, swimmer_id, relay_id, event_id, result_id, meet_id, leg_id, time_ms)
SELECT 1, 'relay_leg', swimmer_id, null, event_id, null, meet_id, id, split_time
FROM (
  SELECT *,
         MIN(split_time) OVER (
           PARTITION BY r.event_id
           ORDER BY m.date, r.split_time, r.id
         ) AS running_best
  FROM relay_legs AS r
  JOIN relays as rel ON r.relay_id = rel.id
  JOIN meets as m ON rel.meet_id = m.id
  WHERE r.is_valid = 1
    AND r.leg_order != 1
) 
WHERE split_time = running_best
  AND event_id = ?`,
    binds: [json.event_id],
  },
],

			(e) => new Errors.InternalDatabase(`Relay Legs database insertion failed: ${e}`),
		),
	)
	.andThen(() => invalidateCacheKey(env, ctx, "relay_legs"))
	.map(() => new Response("Relay Leg successfully added", { status: 201 })),




	"POST /relays": (request, env, ctx) => verifyAuth(request, env)
	.andThen(() => getAndParseRequestJSON(request, relaySchema,
										  (errMsg) => new Errors.MalformedRequest("Given invalid relay data: " + errMsg)))
	.andThen((json) =>
			 queryDBBatched(env.DB, [
				 {
					 query: `
					 INSERT INTO relays (event_id, meet_id, time_ms, is_valid, invalid_reason)
					 VALUES (?, ?, ?, ?, ?)`,
					 binds: [json.event_id, json.meet_id, json.time_ms, json.is_valid, json.invalid_reason]
				 },
				 {
					 query: `SELECT last_insert_rowid() as id`
				 },
				 {
					 query: `
					 DELETE FROM record_progressions as r
					 WHERE r.event_id = ?`,
						 binds: [json.event_id]
				 },
				 {
					 query: `
					 INSERT INTO record_progressions (school_record, type, swimmer_id, relay_id, event_id, result_id, meet_id, leg_id, time_ms)
					 SELECT 1, 'relay', null, id, event_id, null, meet_id, null, time_ms
					 FROM (
						SELECT *,
							MIN(time_ms) OVER (
								PARTITION BY r.event_id
								ORDER BY m.date, r.time_ms, r.id
							) AS running_best
						FROM relays AS r
						JOIN meets as m
						ON r.meet_id = m.id
						WHERE is_valid = 1
					 )
					 WHERE time_ms = running_best
					 AND event_id = ?`,
						 binds: [json.event_id]
				 }
			 ])
			 .map((results) => {
				 const relayId = (results[1] as any as {results: {id:number}[]}).results[0].id;
				 return new Response(
					 JSON.stringify({ message: "Relay successfully added", relay_id: relayId }),
					 { status: 201, headers: { "Content-Type": "application/json" } }
				 );
			 })
	)
	.map((q) => {invalidateCacheKey(env, ctx, "relays"); return q})
	,

	"POST /swimmers": (request, env, ctx) => verifyAuth(request, env)
	.andThen(() => getAndParseRequestJSON(request, swimmerSchema, (errMsg) => new Errors.MalformedRequest("Given invalid swimmer data: " + errMsg)))	
	.andThen((json) => queryDB(env.DB, `
		INSERT INTO swimmers (first_name, last_name, gender, graduating)
		VALUES (?, ?, ?, ?)`,
		(e) => new Errors.InternalDatabase(`Swimmers database insertion failed: ${e}`),
		[json.first_name,json.last_name,json.gender,json.graduating]))
	.map((q) => {invalidateCacheKey(env, ctx, "swimmers"); return q}),

	
	"POST /meets": (request, env, ctx) => verifyAuth(request, env)
	.andThen(() => getAndParseRequestJSON(request, meetSchema, (errMsg) => new Errors.MalformedRequest("Given invalid meet data: " + errMsg)))
	.andThen((json) => queryDB(env.DB, `
		INSERT INTO meets (name, location, date)
		VALUES (?, ?, ?)`,
		(e) => new Errors.InternalDatabase(`Meet database insertion failed: ${e}`), 
		[json.name, json.location, json.date]))
	.map((q) => {invalidateCacheKey(env, ctx, "meets"); return q}),


	"POST /verify": (request, env) => verifyAuth(request, env).map((email) =>
			new Response(
				JSON.stringify({ allowed: true, email }), { headers: { "Content-Type": "application/json" } }
			)
		),
};

function verifyAuth(request: Request, env: env): ResultAsync<string, ErrorRes>{
	const authHeader = request.headers.get("Authorization");
	if (!authHeader?.startsWith("Bearer ")) return errAsync(new Errors.Unauthorized("No Authorization header"));
	const token = authHeader.split(" ")[1];

	const allowedEmails = ["ryanyun2010@gmail.com"];
	return ResultAsync.fromPromise(fetch(
		`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`
	), (e) => new Errors.NoResponse(`Failed to fetch Authentication Token info from Google: ${e}`))
		.andThen((res) => {
			if (!(res instanceof Response)) return errAsync(new Errors.MalformedResponse("Google did not respond with a valid HTTP response when verifying Authentication Token"));
			if (!res.ok) return errAsync(new Errors.Unauthorized(`Google responded with status ${res.status} when verifying Authentication Token`));
			return ResultAsync.fromPromise(res.json(), (e) => new Errors.MalformedResponse(`Failed to parse Authentication Token info JSON recieved from Google: ${e}`))})
		.andThen(zodParseWith(googleTokenSchema, (errMsg) => new Errors.MalformedResponse("Recivied invalid Google token payload: " + errMsg)))
		.andThen(
			(payload) => {
				if (payload.aud != env.GOOGLE_CLIENT_ID) return errAsync(new Errors.Unauthorized("Authorization Token gave Incorrect Audience"));
				if (payload.email_verified !== "true") return errAsync(new Errors.Unauthorized("Authentication Token gave an Email which could not be verified"));
				if (payload.email == null) return errAsync(new Errors.Unauthorized("Authentication Token did not correspond to an Email"));
				if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") return errAsync(new Errors.Unauthorized("Invalid token issuer"));
						if (payload.exp * 1000 < Date.now()) return errAsync(new Errors.Unauthorized("Token expired"));
					if (!allowedEmails.includes(payload.email)) return errAsync(new Errors.Unauthorized("Email is unauthorized"));
				return okAsync(payload.email);
			},
		)
}


function handler (request: Request, env: env, ctx: ExecutionContext): ResultAsync<Response, ErrorRes> {
	let url;
	try {
		url = new URL(request.url);
	} catch (e) {
		return errAsync(new Errors.MalformedRequest(`Invalid URL: ${e}`));
	}

	if (request.method === "OPTIONS") {
		return okAsync(new Response(null, { status: 204 }));
	}

	const key = `${request.method} ${url.pathname}`;
	const route = routes[key];
	if (route != null) {
		return route(request, env, ctx);
	}
	return errAsync(new Errors.NotFound(`Endpoint "${key}" not found`));
} 

export default {
	async fetch(request: Request, env: env, ctx: ExecutionContext): Promise<Response> {
		const withCors = (response: Response) => {
			const newHeaders = new Headers(response.headers);

			newHeaders.set("Access-Control-Allow-Origin", "https://nuevaswimming.pages.dev");
				newHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
			newHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: newHeaders,
			});
		};
		return handler(request, env, ctx).match(
			(response) => withCors(response),
				(error) => {console.error("Error handling request:", error); return withCors(new Response(error.name + ": " +error.message, { status: error.status }))}
		);
	}
};
