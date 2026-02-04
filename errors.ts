export class ErrorRes extends Error {
	status: number;
	name: string;
	constructor(name: string, message: string, status: number) {
		super(message);
		this.name = name;
		this.status = status;
	}
}
export class MalformedRequest extends ErrorRes {
	constructor(message: string) {
		super(message, "MalformedRequestError", 400);
	}
}
export class Unauthorized extends ErrorRes {
	constructor(message: string) {
		super(message, "UnauthorizedError", 401);
	}
}
export class NotFound extends ErrorRes {
	constructor(message: string) {
		super(message, "NotFoundError", 404);
	}
}
export class InternalServer extends ErrorRes {
	constructor(message: string) {
		super(message, "InternalServerError", 500);
	}
}
export class MalformedResponse extends ErrorRes {
	constructor(message: string) {
		super(message, "MalformedResponseError", 502);
	}
}
export class NoResponse extends ErrorRes {
	constructor(message: string) {
		super(message, "NoResponseError", 504);
	}
}
export class InternalDatabase extends ErrorRes {
	constructor(message: string) {
		super(message, "InternalDatabaseError", 520);
	}
}
