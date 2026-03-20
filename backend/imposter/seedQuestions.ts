/**
 * Seed the Questions DynamoDB table.
 *
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
    '"Type the name of the person who you messaged last" "likely"',
    '"Type the name of the person who is most likely to become rich" "likely"',
    '"Type the name of the person who is most likely to become homeless" "likely"',
    '"Type the name of the person who is most likely to get robbed" "likely"',
    '"Type the name of the person who is most likely to go to jail" "likely"',
    '"Type the name of the person who is most likely to become a teenage parent" "likely"',
    '"Type the name of the person who is most likely to fart during sex" "likely"',
    '"Type the name of the person who is most likely to have a baby mama/daddy" "likely"',
    '"Type the name of the person who is most likely to become a model" "likely"',
    '"Type the name of the person who is most likely to get catfished on a date" "likely"',
    '"Type the name of the person who is most likely to survive a zombie apocalypse" "likely"',
    '"Type the name of the person who is most likely to accidentally leak a secret" "likely"',
    '"Type the name of the person who is most likely to go on singles inferno" "likely"',
    '"Type the name of the person who is most likely to fall asleep first at a party" "likely"',
    '"Type the name of the person who is most likely to marry first" "likely"',
    '"Type the name of the person who is most likely to cry (for anything)" "likely"',
    '"Type the name of the person who is most likely to leave you on read" "likely"',
    '"Type the name of the person who is most likely to be late" "likely"',
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
