declare module "better-sqlite3" {
  class Database {
    constructor(filename: string);
    pragma(command: string): unknown;
    exec(sql: string): unknown;
    prepare<BindParameters extends unknown[] = unknown[], Result = unknown>(sql: string): {
      run: (...params: BindParameters) => unknown;
      get: (...params: BindParameters) => Result | undefined;
      all: (...params: BindParameters) => Result[];
    };
  }

  export default Database;
}
