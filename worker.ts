/// <reference types="@cloudflare/workers-types" />
import {ResultAsync, okAsync, errAsync} from "neverthrow";
import { z, ZodError } from "zod";
import * as Errors from "./errors";
import {ErrorRes} from "./errors";

interface env {
	DB: D1Database;
	GOOGLE_CLIENT_ID: string;
}

const googleTokenSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string(),
  email: z.string().email().optional(),
  email_verified: z.enum(["true", "false"]).optional(),
  name: z.string().optional(),
  picture: z.string().url().optional(),
  iat: z.coerce.number(),
  exp: z.coerce.number(),
});

const allowedEvents = [
	"50_free",
	"50_back",
	"50_breast",
	"50_fly",
	"100_free",
	"100_back",
	"100_breast",
	"100_fly",
	"200_free",
	"200_im",
	"500_free"
];

const meetSchema = z.object({
  name: z.string().min(1, "Name is required"),
  location: z.string().min(1, "Location is required"),
  date: z.number().int("Date must be an integer"),
});

const recordSchema = z.array(
  z.object({
    meet_id: z.number().int(),
    swimmer_id: z.number().int(),
    event: z.enum(allowedEvents),
    type: z.enum(["individual", "relay"]),
    start: z.enum(["flat", "relay"]),
    time: z.number().positive(),
  })
);

const swimmerSchema = z.object({
  name: z.string().min(1, "Name is required"),
  graduating_year: z.number().int(),
});

const relaySchema = z.object({
  time: z.number().positive(),
  relay_type: z.enum(["200_mr", "200_fr", "400_fr"]),
  record_1_id: z.number().int(),
  record_2_id: z.number().int(),
  record_3_id: z.number().int(),
  record_4_id: z.number().int(),
});



function zodErrorToHumanReadable(err: ZodError) {
  return err.issues
    .map(i => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
}

function zodParseWith<T>(schema: z.ZodSchema<T>, errFunc: (errMsg: string) => ErrorRes
						): (json: unknown) => ResultAsync<T, ErrorRes> {
	return (json: unknown) => {
		const parseResult = schema.safeParse(json);
		if (!parseResult.success) {
			return errAsync(errFunc(zodErrorToHumanReadable(parseResult.error)));
		}
		return okAsync(parseResult.data);
	};
}

function queryDB(db: D1Database, query: string, 
				 errFunc: (errMsg: string) => ErrorRes = (e: string) => new Errors.InternalDatabase(`Failed to query database: ${e}`),
			     binds: any[] = []
				 ): ResultAsync<any, ErrorRes> {

	return ResultAsync.fromPromise(
		db.prepare(query).bind(...binds).all(),
		(e) => errFunc(JSON.stringify(e))
	);
}

function returnJSONResponse(data: any, status: number = 200): Response {
	return new Response(JSON.stringify(data), {
		status: status,
		headers: { "Content-Type": "application/json" }
	});
}

function getRequestJSON(request: Request, 
						errFunc: (errMsg: string) => ErrorRes = (e: string) => new Errors.MalformedRequest(`Failed to parse request JSON: ${e}`)
					    ): ResultAsync<any, ErrorRes> {
	return ResultAsync.fromPromise(
		request.json(),
		(e) => errFunc(JSON.stringify(e))
	);
}

function getAndParseRequestJSON<T>(request: Request, schema: z.ZodSchema<T>, 
								   zodParseFailErrFunc: (errMsg: string) => ErrorRes, 
								   requestJSONFailErrFunc: (errMsg: string) => ErrorRes = (e: string) => new Errors.MalformedRequest(`Failed to parse request JSON: ${e}`)
								   ): ResultAsync<T, ErrorRes> {
	return getRequestJSON(request, requestJSONFailErrFunc).andThen(zodParseWith(schema, zodParseFailErrFunc));
}



const routes: Record<string, (request: Request, env: env) => ResultAsync<Response, ErrorRes>> = {

	"GET /": (_request, env) => queryDB(env.DB,`
			SELECT
			r.id,
			r.swimmer_id,
			r.event,
			r.type,
			r.time,
			r.start,
			m.name AS meet_name,
			m.location AS meet_location,
			m.date AS meet_date,
			s.name AS swimmer_name,
			s.graduating_year AS swimmer_year
			FROM records r
			JOIN meets m ON r.meet_id = m.id
			JOIN swimmers s ON r.swimmer_id = s.id
			ORDER BY m.date DESC, r.time ASC`
		).map((res) => returnJSONResponse(res)),



	"GET /meets": (_request, env) => queryDB(env.DB, `
			SELECT id, name, location, date
			FROM meets
			ORDER BY date DESC `
		).map((res) => returnJSONResponse(res)),



	"POST /meets": (request, env) => verifyAuth(request, env)
		.andThen(() => getAndParseRequestJSON(request, meetSchema, (errMsg) => new Errors.MalformedRequest("Given invalid meet data: " + errMsg)))
		.andThen((json) => queryDB(env.DB, `
			INSERT INTO meets (name, location, date)
			VALUES (?, ?, ?)`,
			(e) => new Errors.InternalDatabase(`Meet database insertion failed: ${e}`), [json.name, json.location, json.date])
		), 


	
	"GET /records": (_request, env) => queryDB(env.DB,`
			SELECT *			
			FROM records
			ORDER BY id DESC `
		).map((res) => returnJSONResponse(res)),


	
	"POST /records": (request, env) => verifyAuth(request, env)
		.andThen(() => getAndParseRequestJSON(request, recordSchema, (errMsg) => new Errors.MalformedRequest("Given invalid record data: " + errMsg)))
		.andThen(
			(json) => {
				const placeholders = json.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
				const values = json.flatMap((record) => [
					record.meet_id,
					record.swimmer_id,
					record.event,
					record.type,
					record.time,
					record.start
				]);
				return queryDB(env.DB, `
					INSERT INTO records
					(meet_id, swimmer_id, event, type, time, start)
					VALUES ${placeholders}`,
					(e) => new Errors.InternalDatabase(`Records database insertion failed: ${e}`), values)
				.map((_) => new Response("Records sucessfully added", { status: 201 }));
			}),



	"GET /swimmers": (_request, env) => queryDB(env.DB,`
			SELECT id, name, graduating_year
			FROM swimmers
			ORDER BY id ASC `
		).map((res) => returnJSONResponse(res)),	



	"POST /swimmers": (request, env) => verifyAuth(request, env).andThen(() => getAndParseRequestJSON(request, swimmerSchema, (errMsg) => new Errors.MalformedRequest("Given invalid swimmer data: " + errMsg)))
		.andThen(
			(json) => queryDB(env.DB,`
				INSERT INTO swimmers
				(name, graduating_year)
				VALUES (?, ?)`,
				(e) => new Errors.InternalDatabase(`Swimmers database insertion failed: ${e}`),
				[json.name, json.graduating_year])
			.map((_) => new Response("Swimmer added", { status: 201 }))
		),



	"GET /recent_meets": (_request, env) => queryDB(env.DB,`
				SELECT id, name, location, date
				FROM meets
				ORDER BY date DESC
				LIMIT 5 `
			).map((res) => returnJSONResponse(res)),

	"POST /verify": (request, env) => verifyAuth(request, env).map((email) =>
			new Response(
				JSON.stringify({ allowed: true, email }), { headers: { "Content-Type": "application/json" } }
			)
		),

	"POST /relays": (request, env) => verifyAuth(request, env).andThen(() => getAndParseRequestJSON(request, relaySchema, (errMsg) => new Errors.MalformedRequest("Given invalid relay data: " + errMsg)))
		.andThen(
		(json) => queryDB(env.DB,`
					INSERT INTO relays
					(time, type, record_1_id, record_2_id, record_3_id, record_4_id)
					VALUES (?, ?, ?, ?, ?, ?)`,
					(e) => new Errors.InternalDatabase(`Relays database insertion failed: ${e}`),
					[json.time, json.relay_type, json.record_1_id, json.record_2_id, json.record_3_id, json.record_4_id])
				.map((_) => new Response("Relay added", { status: 201 })))
};

function verifyAuth(request: Request, env: env): ResultAsync<string, ErrorRes>{
	const authHeader = request.headers.get("Authorization");
	if (!authHeader?.startsWith("Bearer ")) return errAsync(new Errors.Unauthorized("No Authorization header"));
	const token = authHeader.split(" ")[1];

	const allowedEmails = ["ryanyun2010@gmail.com"];
	return ResultAsync.fromPromise(fetch(
		`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`
	), (e) => new Errors.NoResponse(`Failed to fetch Authentication Token info from Google: ${e}`))
		.andThen((res) => ResultAsync.fromPromise(res.json(), (e) => new Errors.MalformedResponse(`Failed to parse Authentication Token info JSON recieved from Google: ${e}`)))
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


function handler (request: Request, env: env): ResultAsync<Response, ErrorRes> {
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
		return route(request, env);
	}
	return errAsync(new Errors.NotFound(`Endpoint "${key}" not found`));
} 

export default {
	async fetch(request: Request, env: env) {
		const withCors = (response: Response) => {
			response.headers.set(
				"Access-Control-Allow-Origin",
				"https://nuevaswimming.pages.dev"
			);
			response.headers.set(
				"Access-Control-Allow-Methods",
				"GET, POST, OPTIONS"
			);
			response.headers.set(
				"Access-Control-Allow-Headers",
				"Content-Type, Authorization"
			);
			return response;
		};
		return handler(request, env).match(
			(response) => withCors(response),
			(error) => withCors(new Response(error.name + ": " +error.message, { status: error.status }))
		);
	}
};
