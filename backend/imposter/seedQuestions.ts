/**
 * Seed the Questions DynamoDB table.
 *
 * cd into the imposter folder and run:
 * RUN THIS SCRIPT BY ADDING QUESTIONS TO THE questionsToAdd ARRAY AND RUNNING: AWS_PROFILE=mpkam npm run seed
 *
 * Each row is written with `safe` (BOOL). Omit the third token in the string to default safe=true.
 */
import { DynamoDBClient, BatchWriteItemCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import * as crypto from 'crypto';

const TABLE_NAME = process.env.QUESTIONS_TABLE ?? 'Questions';
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2';

// ──────────────────────────────────────────────
// ADD YOUR QUESTIONS HERE
// Format: '"<question>" "<range>"'  → safe defaults to true
//     or: '"<question>" "<range>" "<safe>"'  → safe is true|false (also accepts 1|0)
// ──────────────────────────────────────────────
const questionsToAdd = [
    '"Longest time in days you’ve gone without showering?" "1-10"',
    '"Longest time in days you’ve gone without shitting?" "1-10"',
    '"How many days could you go eating the exact same meal?" "1-25"',
    '"What age would you go back to and start life from (you keep your memories)?" "1-25"',
    '"How many times have you farted or coughed since starting this game?" "1-10"',
    '"If you could, how many inches would you take off everyone’s height except yourself?" "1-10"',
    '"Type the name of the person most likely to get blamed for farting." "likely"',
    '"Type the name of the person most likely to be fat in the future." "likely"',
    '"Type the name of the person most likely to get away with murder." "likely"',
    '"Type the name of the person most likely to accidentally commit a crime." "likely"',
    '"Type the name of the person most likely to forget their passport before a flight." "likely"',
];

function generateId(): string {
    return 'q' + crypto.randomBytes(4).toString('hex');
}

function parseSafeToken(token: string): boolean {
    const t = token.trim().toLowerCase();
    if (t === 'true' || t === '1') return true;
    if (t === 'false' || t === '0') return false;
    throw new Error(`Invalid safe value "${token}" — use true or false`);
}

function parseEntry(raw: string): { question: string; range: string; safe: boolean } {
    const matches = raw.match(/"([^"]+)"/g);
    if (!matches || matches.length < 2) {
        throw new Error(`Need at least question and range in quotes: ${raw}`);
    }
    if (matches.length > 3) {
        throw new Error(`Too many quoted segments (use 2 or 3): ${raw}`);
    }
    const question = matches[0].slice(1, -1);
    const range = matches[1].slice(1, -1);
    if (matches.length === 2) {
        return { question, range, safe: true };
    }
    return { question, range, safe: parseSafeToken(matches[2].slice(1, -1)) };
}

async function seed() {
    const client = new DynamoDBClient({ region: REGION });

    let tableArn: string | undefined;
    try {
        const desc = await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
        tableArn = desc.Table?.TableArn;
    } catch (e: unknown) {
        const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: string }).name) : '';
        if (name === 'ResourceNotFoundException') {
            console.error(
                `\nTable "${TABLE_NAME}" was not found in region "${REGION}" for your current AWS credentials.\n` +
                `Fix: set AWS_PROFILE / AWS_REGION / QUESTIONS_TABLE to match the account where you deployed SAM.\n`,
            );
        }
        throw e;
    }

    const accountFromArn = tableArn?.match(/^arn:aws:dynamodb:[^:]+:(\d+):table\//)?.[1];
    console.log('\n── Seeding DynamoDB ──');
    console.log(`  Region:      ${REGION}`);
    console.log(`  Table:       ${TABLE_NAME}`);
    console.log(`  Table ARN:   ${tableArn ?? '(unknown)'}`);
    if (accountFromArn) console.log(`  Account ID:  ${accountFromArn}`);
    console.log(`  AWS_PROFILE: ${process.env.AWS_PROFILE ?? '(default credential chain)'}\n`);

    const items = questionsToAdd.map((raw) => {
        const { question, range, safe } = parseEntry(raw);
        const questionId = generateId();
        console.log(`  ${questionId}  |  range=${range}  |  safe=${safe}  |  ${question}`);
        return {
            PutRequest: {
                Item: {
                    questionId: { S: questionId },
                    question: { S: question },
                    range: { S: range },
                    safe: { BOOL: safe },
                },
            },
        };
    });

    // BatchWriteItem accepts max 25 items per call
    for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        await client.send(
            new BatchWriteItemCommand({
                RequestItems: { [TABLE_NAME]: batch },
            }),
        );
    }

    console.log(`\nDone — ${items.length} question(s) written to "${TABLE_NAME}".`);
}

seed().catch((err) => {
    console.error('Failed to seed questions:', err);
    process.exit(1);
});
