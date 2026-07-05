import { readFileSync } from 'node:fs'
import { request } from 'node:https'

/**
 * Minimal Kubernetes API client (agent-runtime ADR 0010 §1.3): raw node:https against
 * kubernetes.default.svc with the mounted ServiceAccount token — no npm dependency. Four
 * operations only (create/get/list/delete pod); the manager polls, it never watches.
 */

const TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'
const CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'
const API_HOST = 'kubernetes.default.svc'
const API_PORT = 443

export interface HttpError extends Error {
  status: number
  body?: unknown
}

export interface K8sPods {
  createPod(pod: Record<string, unknown>): Promise<any>
  getPod(name: string): Promise<any | undefined>
  listPods(labelSelector: string): Promise<any[]>
  deletePod(name: string): Promise<void>
}

export class K8sClient implements K8sPods {
  private readonly token: string
  private readonly ca: Buffer

  constructor(private readonly namespace: string) {
    this.token = readFileSync(TOKEN_PATH, 'utf8').trim()
    this.ca = readFileSync(CA_PATH)
  }

  async createPod(pod: Record<string, unknown>): Promise<any> {
    return this.call('POST', `/api/v1/namespaces/${this.namespace}/pods`, pod)
  }

  async getPod(name: string): Promise<any | undefined> {
    try {
      return await this.call('GET', `/api/v1/namespaces/${this.namespace}/pods/${name}`)
    } catch (err) {
      if ((err as HttpError).status === 404) return undefined
      throw err
    }
  }

  async listPods(labelSelector: string): Promise<any[]> {
    const path = `/api/v1/namespaces/${this.namespace}/pods?labelSelector=${encodeURIComponent(labelSelector)}`
    const res = await this.call('GET', path)
    return res.items ?? []
  }

  async deletePod(name: string): Promise<void> {
    try {
      await this.call('DELETE', `/api/v1/namespaces/${this.namespace}/pods/${name}`)
    } catch (err) {
      if ((err as HttpError).status === 404) return
      throw err
    }
  }

  private call(method: string, path: string, body?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined
      const req = request(
        {
          method,
          hostname: API_HOST,
          port: API_PORT,
          path,
          ca: this.ca,
          headers: {
            authorization: `Bearer ${this.token}`,
            'content-type': 'application/json',
            ...(data ? { 'content-length': String(data.length) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            const status = res.statusCode ?? 0
            let json: unknown
            try {
              json = text ? JSON.parse(text) : undefined
            } catch {
              json = text
            }
            if (status >= 200 && status < 300) return resolve(json)
            const err = new Error(`k8s API ${method} ${path} -> ${status}`) as HttpError
            err.status = status
            err.body = json
            reject(err)
          })
        },
      )
      req.on('error', reject)
      if (data) req.write(data)
      req.end()
    })
  }
}
