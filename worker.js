export default {
	async fetch(request, env) {
		const responder = async (request, env) => {
			try {
				const url = new URL(request.url);

				if (request.method === "OPTIONS") {
					return new Response(null, { status: 204 });
				}

				async function verifyAuth() {
					try {
						const authHeader = request.headers.get("Authorization");
						if (!authHeader?.startsWith("Bearer ")) return null;

						const token = authHeader.split(" ")[1];
						const googleRes = await fetch(
							`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`
						);
						if (!googleRes.ok) return null;

						const payload = await googleRes.json();

						if (payload.aud !== env.GOOGLE_CLIENT_ID) return null;
						if (payload.email_verified !== "true") return null;

						const allowedEmails = ["ryanyun2010@gmail.com"];
						if (!allowedEmails.includes(payload.email)) return null;

						return payload.email;
					} catch (err) {
						console.error("Auth error:", err);
						return null;
					}
				}

				const ALLOWED_EVENTS = [
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

				if (request.method === "GET" && url.pathname === "/") {
					const res = await env.DB.prepare(
						`
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
						ORDER BY m.date DESC, r.time ASC
						`
					).all();

					return new Response(JSON.stringify(res.results), {
						headers: { "Content-Type": "application/json" }
					});
				}

				if (request.method === "GET" && url.pathname === "/meets") {
					const res = await env.DB.prepare(
						`
						SELECT id, name, location, date
						FROM meets
						ORDER BY date DESC
						`
					).all();

					return new Response(JSON.stringify(res.results), {
						headers: { "Content-Type": "application/json" }
					});
				}

				if (request.method === "GET" && url.pathname === "/swimmers") {
					const res = await env.DB.prepare(
						`
						SELECT id, name, graduating_year
						FROM swimmers
						ORDER BY id ASC
						`
					).all();

					return new Response(JSON.stringify(res.results), {
						headers: { "Content-Type": "application/json" }
					});
				}


				if (request.method === "POST" && url.pathname === "/meets") {
					const email = await verifyAuth();
					if (!email)
						return new Response("Unauthorized", { status: 401 });

					const { name, location, date } = await request.json();

					if (!name || !location || !Number.isInteger(date)) {
						return new Response("Invalid meet data", {
							status: 400
						});
					}

					await env.DB.prepare(
						`
						INSERT INTO meets (name, location, date)
						VALUES (?, ?, ?)
						`
					)
						.bind(name, location, date)
						.run();

					return new Response("Meet added", { status: 201 });
				}

				if (request.method === "POST" && url.pathname === "/records") {
					const email = await verifyAuth();
					if (!email)
						return new Response("Unauthorized", { status: 401 });

					const { swimmer_id, meet_id, event, type, start, time } =
						await request.json();

					if (
						!Number.isInteger(meet_id) ||
						!Number.isInteger(swimmer_id) ||
						!ALLOWED_EVENTS.includes(event) ||
						!["individual", "relay"].includes(type) ||
						!["flat", "relay"].includes(start) ||
						typeof time !== "number" ||
						time <= 0
					) {
						return new Response("Invalid record data", {
							status: 400
						});
					}

					await env.DB.prepare(
						`
						INSERT INTO records
						(swimmer_id, meet_id, event, type, time, start)
						VALUES (?, ?, ?, ?, ?, ?)
						`
					)
						.bind(swimmer_id, meet_id, event, type, time, start)
						.run();

					return new Response("Record added", { status: 201 });
				}


				if (request.method === "POST" && url.pathname === "/swimmers") {
					const email = await verifyAuth();
					if (!email)
						return new Response("Unauthorized", { status: 401 });
					const { name, graduating_year} = await request.json();

					if (
						!Number.isInteger(graduating_year)
					) {
						return new Response("Invalid record data", {
							status: 400
						});
					}

					await env.DB.prepare(
						`
						INSERT INTO swimmers
						(name, graduating_year)
						VALUES (?, ?)
						`
					)
						.bind(name, graduating_year)
						.run();

					return new Response("Record added", { status: 201 });
				}


				if (request.method === "POST" && url.pathname === "/verify") {
					const email = await verifyAuth();
					if (!email)
						return new Response("Unauthorized", { status: 401 });

					return new Response(
						JSON.stringify({ allowed: true, email }),
						{
							headers: { "Content-Type": "application/json" }
						}
					);
				}

				return new Response("Not Found", { status: 404 });
			} catch (err) {
				console.error("Unhandled error:", err);

				return new Response(
					JSON.stringify({ error: "Internal Server Error: " + err.message }),
					{
						status: 500,
						headers: { "Content-Type": "application/json" }
					}
				);
			}
		};

		const withCors = (response) => {
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

		return withCors(await responder(request, env));
	}
};
