// Threads run on restricted Windows hosts where child-process workers cannot spawn.
export default { test: { pool: "threads" } };
