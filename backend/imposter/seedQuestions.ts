/**
 * Seed the Questions DynamoDB table.
 *
 * Which account / region / table?
 * - Credentials: default AWS chain (e.g. ~/.aws/credentials). Use the same profile you use for `sam deploy`.
 *   AWS_PROFILE=my-profile npm run seed
 * - Region: must match where the table exists (same as API Gateway in your .env).
 *   AWS_REGION=us-west-2 npm run seed
 * - Table: must match Lambda env QUESTIONS_TABLE in template.yaml (default "Questions").
 *   QUESTIONS_TABLE=Questions npm run seed
 *
 * Verify before running:
 *   aws sts get-caller-identity --profile <optional>
 *   aws dynamodb describe-table --table-name Questions --region us-west-2
 * The script prints the table ARN before writing; the account ID in the ARN should match get-caller-identity.
 */
import { DynamoDBClient, BatchWriteItemCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import * as crypto from 'crypto';

const TABLE_NAME = process.env.QUESTIONS_TABLE ?? 'Questions';
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2';

// ──────────────────────────────────────────────
// ADD YOUR QUESTIONS HERE
// Format: '"<question>" "<range>"'
// ──────────────────────────────────────────────
const questionsToAdd = [
    // 1-10
    '"How many people would you kill if you wouldn\'t get caught?" "1-10"',
    '"How many shots until you\'re tipsy?" "1-10"',
    '"Most times you\'ve shit in a single day?" "1-10"',
    '"Biggest age gap you\'d be open to having with a significant other?" "1-10"',
    '"How many years should you date before marrying?" "1-10"',
    '"Best age gap to have with siblings?" "1-10"',
    '"What\'s your average screen time per day?" "1-10"',
    // 1-25
    '"Most drinks drank in a night?" "1-25"',
    '"How many books have you read in the past 10 years?" "1-25"',
    '"What age was your favourite birthday?" "1-25"',
    '"How many friends do you see per month?" "1-25"',
    '"Farthest distance ran? (in km)" "1-25"',
    '"How many slaps do you think you could take from the person on your right?" "1-25"',
    '"How many shots could you take before blacking out?" "1-25"',
    '"What body count is too high for a potential partner (romantic)?" "1-25"',
    '"Most TV episodes binged in a day?" "1-25"',
    '"Preferred age you would date?" "1-25"',
    '"How many cheeseburgers can you eat in one sitting?" "1-25"',
];

function generateId(): string {
    return 'q' + crypto.randomBytes(4).toString('hex');
}

function parseEntry(raw: string): { question: string; range: string } {
    const matches = raw.match(/"([^"]+)"/g);
    if (!matches || matches.length < 2) {
        throw new Error(`Bad format: ${raw}`);
    }
    return {
        question: matches[0].slice(1, -1),
        range: matches[matches.length - 1].slice(1, -1),
    };
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
        const { question, range } = parseEntry(raw);
        const questionId = generateId();
        console.log(`  ${questionId}  |  range=${range}  |  ${question}`);
        return {
            PutRequest: {
                Item: {
                    questionId: { S: questionId },
                    question: { S: question },
                    range: { S: range },
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
