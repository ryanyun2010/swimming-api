export class ErrorRes extends Error {
    status;
    name;
    constructor(name, message, status) {
        super(message);
        this.name = name;
        this.status = status;
    }
}
export class MalformedRequest extends ErrorRes {
    constructor(message) {
        super(message, "MalformedRequestError", 400);
    }
}
export class Unauthorized extends ErrorRes {
    constructor(message) {
        super(message, "UnauthorizedError", 401);
    }
}
export class NotFound extends ErrorRes {
    constructor(message) {
        super(message, "NotFoundError", 404);
    }
}
export class InternalServer extends ErrorRes {
    constructor(message) {
        super(message, "InternalServerError", 500);
    }
}
export class MalformedResponse extends ErrorRes {
    constructor(message) {
        super(message, "MalformedResponseError", 502);
    }
}
export class NoResponse extends ErrorRes {
    constructor(message) {
        super(message, "NoResponseError", 504);
    }
}
export class InternalDatabase extends ErrorRes {
    constructor(message) {
        super(message, "InternalDatabaseError", 520);
    }
}
