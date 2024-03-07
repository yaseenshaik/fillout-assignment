import express, { Express, Request, Response } from 'express'
import dotenv from 'dotenv'
import {
  Result,
  ExpressValidator,
  // query,
  validationResult,
} from 'express-validator'
import validator from 'validator'
import axios from 'axios'

dotenv.config()

if (!process.env.FILLOUT_SK) {
  console.error(Error('[ENV] Missing FILLOUT_SK!'))
  process.exit(1)
}

const app: Express = express()
const port = process.env.PORT || 3000

app.use(express.json())

app.get('/', (req: Request, res: Response) => {
  res.send('Fillout assignment')
})

type FilterClauseType = {
  id: string
  condition: 'equals' | 'does_not_equal' | 'greater_than' | 'less_than'
  value: number | string
}

// each of these filters should be applied like an AND in a "where" clause
// in SQL
type ResponseFiltersType = FilterClauseType[]

const showError = (field: string) => new Error(`${field} is invalid`)

const { query } = new ExpressValidator({
  validateFilters: (filters: string) => {
    const filterClauses = JSON.parse(filters)

    filterClauses.forEach(
      (filter: { id: string; condition: string; value: string }) => {
        if (validator.isEmpty(filter.id)) throw showError('id')
        if (
          !validator.isIn(filter.condition, [
            'equals',
            'does_not_equal',
            'greater_than',
            'less_than',
          ])
        )
          throw showError('condition')
        if (!['string', 'number'].includes(typeof filter.value))
          throw showError('value')
      },
    )

    return true
  },
})

const cache = new Map()
const queue: string[] = []
const maxLen = 10

const createHash = (params: object) => JSON.stringify(params)

const cacheData = (key: string, responses: object) => {
  if (queue.length === maxLen) {
    const oldestResponse = queue.shift()
    cache.delete(oldestResponse)
  }

  cache.set(key, responses)
  queue.push(key)
}

interface HasId {
  id: string
}

type HasIdWithValue = HasId & {
  value: number | string
}

type Submission = { questions: HasIdWithValue[] }

app.get(
  '/:formId/filteredResponses',
  query('filters').optional().isJSON().validateFilters(),
  query('limit').optional().isInt({ min: 0, max: 150 }),
  query('afterDate').optional().isISO8601(),
  query('beforeDate').optional().isISO8601(),
  query('offset').optional().isInt(),
  query('status').optional().isIn(['in_progress', 'finished']),
  query('includeEditLink').optional().isBoolean(),
  query('sort').optional().isIn(['asc', 'desc']),
  async (req: Request, res: Response) => {
    const result: Result = validationResult(req)
    if (!result.isEmpty()) return res.json({ errors: result.array() })

    const { afterDate, beforeDate, status, includeEditLink, sort } = req.query
    const params = {
      afterDate,
      beforeDate,
      status,
      includeEditLink,
      sort,
    }

    const getPage = (offset: number) => {
      return axios.get(
        `https://api.fillout.com/v1/api/forms/${req.params.formId}/submissions`,
        {
          params: { ...params, offset },
          headers: { Authorization: `Bearer ${process.env.FILLOUT_SK}` },
        },
      )
    }
    let responses: Submission[] = []
    let offset = 0
    let totalPages = Number.POSITIVE_INFINITY
    const key = createHash({ formId: req.params.formId, ...params })

    if (cache.has(key)) {
      // console.log('using cache')
      responses = [...cache.get(key)]
    } else {
      while (offset < totalPages) {
        try {
          const resp = await getPage(offset)
          responses = [...responses, ...resp.data.responses]
          offset += 150
          totalPages = resp.data.pageCount
        } catch (e) {
          // console.error(e)
          return res.json({ error: 'Request failed!' })
        }
      }
      cacheData(key, responses)
    }

    let resOffset = 0
    let resLimit = 150
    if (typeof req.query.offset == 'string') {
      resOffset = parseInt(req.query.offset)
    }
    if (typeof req.query.limit == 'string') {
      resLimit = parseInt(req.query.limit)
    }

    if (typeof req.query.filters == 'string') {
      const filters = JSON.parse(req.query.filters)
      const conditions = new Map()
      filters.forEach((filter: HasId) => {
        conditions.set(filter.id, filter)
      })
      responses = responses.filter((response) => {
        const checks: boolean[] = []
        response.questions.forEach((question) => {
          if (conditions.has(question.id)) {
            const condition = conditions.get(question.id)

            switch (condition.condition) {
              case 'equals':
                checks.push(question.value === condition.value)
                break
              case 'does_not_equal':
                checks.push(question.value !== condition.value)
                break
              case 'greater_than':
                checks.push(question.value > condition.value)
                break
              case 'less_than':
                checks.push(question.value < condition.value)
                break
            }
          }
        })
        const failed = checks.findIndex((check) => !check)
        return failed == -1
      })
    }

    res.send({
      responses: responses.slice(resOffset, resLimit + resOffset),
      totalResponses: responses.length,
      pageCount: Math.ceil(responses.length / resLimit),
    })
  },
)

app.listen(port, () => {
  console.log(`[server]: Server is running at http://localhost:${port}`)
})
