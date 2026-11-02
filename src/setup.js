import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const file = path.resolve(process.env.COCREATE_CONFIG || "cocreate-loadtest.config.json");
let existing = {};
try { existing = JSON.parse(await fs.readFile(file, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }

const prompt = readline.createInterface({ input, output });
const answers = prompt[Symbol.asyncIterator]();
async function ask(label, current = "", secret = false) {
	const suffix = current ? ` [${secret ? "configured" : current}]: ` : ": ";
	output.write(`${label}${suffix}`);
	const answer = await answers.next();
	if (answer.done) return current;
	return answer.value || current;
}

try {
	const config = {
		...existing,
		host: await ask("CoCreate host", existing.host),
		organization_id: await ask("Organization ID", existing.organization_id),
		apikey: await ask("API key (optional)", existing.apikey || existing.key, true)
	};
	if (!config.host || !config.organization_id) throw new Error("Host and organization ID are required.");
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	await fs.chmod(file, 0o600);
	console.log(`Saved local load-test configuration to ${file}`);
} finally {
	prompt.close();
}
