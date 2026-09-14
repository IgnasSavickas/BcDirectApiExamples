var builder = DistributedApplication.CreateBuilder(args);

// PostgreSQL database (runs as a container via Docker).
// WithDataVolume() persists data across restarts so pulled customers survive.
var postgres = builder.AddPostgres("postgres")
    .WithDataVolume()
    .WithPgAdmin();

var db = postgres.AddDatabase("bcdata");

// TypeScript API (Fastify + @navapi/core). Aspire injects the Postgres
// connection string as the ConnectionStrings__bcdata environment variable
// and a PORT to listen on.
var api = builder.AddNpmApp("api", "../api", "dev")
    .WithReference(db)
    .WaitFor(db)
    .WithHttpEndpoint(env: "PORT")
    .WithExternalHttpEndpoints();

// TypeScript web frontend (Vite + React). Gets the API's URL through Aspire
// service discovery (services__api__http__0) for its dev-server proxy.
builder.AddNpmApp("web", "../web", "dev")
    .WithReference(api)
    .WaitFor(api)
    .WithHttpEndpoint(env: "PORT")
    .WithExternalHttpEndpoints();

builder.Build().Run();
