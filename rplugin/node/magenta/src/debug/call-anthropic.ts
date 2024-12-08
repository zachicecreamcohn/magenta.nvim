import { AnthropicClient } from '../anthropic'
import { Logger } from '../logger'

const logger = new Logger({
  outWriteLine: () => Promise.resolve(undefined),
  errWriteLine: () => Promise.resolve(undefined)
}, {
  level: 'trace'
})

async function run() {
  const client = new AnthropicClient(logger)

  await client.sendMessage([{
    role: 'user',
    content: 'try reading the contents of the file ./src/index.js'
  }], (text) => {
    return Promise.resolve(console.log('text: ' + text))
  })
}

run().then(() => {
  console.log('success');
  process.exit(0)
}, (err) => {
  console.error(err);
  process.exit(1)
})
