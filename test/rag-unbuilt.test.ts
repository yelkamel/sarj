import { expect, test } from "@jest/globals";
import { search } from "../src/rag.js";

// Own file = own module instance: the index has never been built here.
test("searching before buildIndex() is a loud error, not an empty answer", async () => {
  await expect(search("q")).rejects.toThrow("index not built");
});
