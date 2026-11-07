import { trySendMsg2Runtime } from '@api/sw/common'
import locationWatcher from '@cs/location-watcher'
import NormalTracker from "@cs/tracker/normal"
import { calcRealLimit, meetLimit, visitScopeKey } from '@util/limit'
import { MILL_PER_SECOND } from "@util/time"
import { isSameReason } from '../common'
import DelayCoordinator from '../manager/delay-coordinator'
import LimitState from '../manager/state'
import type { LimitReason, Processor, SharedOption, VisitData } from '../types'

class VisitProcessor implements Processor, VisitData {
    #mills: number = 0
    #rules: tt4b.limit.Rule[] = []
    #tracker: NormalTracker
    #delayCount: number = 0
    #listeners: ArgCallback<number>[] = []
    /**
     * The URL which {@link #rules} were loaded for
     */
    #rulesUrl: string
    /**
     * Key of the per-visit rules matching {@link #rulesUrl}
     */
    #scopeKey: string | undefined
    #resetSeq: number = 0

    get mills() {
        return this.#mills
    }

    get delayCount() {
        return this.#delayCount
    }

    constructor(
        private readonly state: LimitState,
        private readonly delayCoord: DelayCoordinator,
        private readonly option: SharedOption,
    ) {
        this.#rulesUrl = locationWatcher.url
        this.#tracker = new NormalTracker({
            onReport: data => this.handleTracker(data),
        })
    }

    onChange(listener: ArgCallback<number>) {
        this.#listeners.push(listener)
        listener(this.#mills)
    }

    #notify() {
        this.#listeners.forEach(l => l(this.#mills))
    }

    private hasLimited(rule: tt4b.limit.Rule): boolean {
        const { visitTime, allowDelay } = rule
        if (!visitTime) return false
        const delay = {
            count: this.#delayCount,
            duration: this.option.delayDuration,
            allow: allowDelay,
        }
        return meetLimit(calcRealLimit(visitTime * MILL_PER_SECOND, delay), this.#mills)
    }

    private async handleTracker({ start, end }: tt4b.core.Event) {
        const diff = end - start
        this.#mills += diff
        if (locationWatcher.isWhite) return
        this.#notify()
        // Rules of the new URL are still loading
        if (locationWatcher.url !== this.#rulesUrl) return
        this.state.add(...this.#limitedReasons())
    }

    #limitedReasons(): LimitReason[] {
        const reasons: LimitReason[] = []
        this.#rules.forEach(rule => {
            if (!this.hasLimited(rule)) return
            const { id, cond, allowDelay } = rule
            reasons.push({
                id,
                cond,
                type: 'VISIT',
                allowDelay,
                delayCount: this.#delayCount,
            })
        })
        return reasons
    }

    async init(): Promise<void> {
        this.#tracker.init(this.state)
        this.delayCoord.register(() => {
            this.#delayCount++
            this.state.removeByType('VISIT')
        }, 'VISIT')

        await this.reset()
    }

    /**
     * Reload rules, called when the URL or rules changed.
     *
     * The visit continues while the URL keeps matching the same per-visit rules,
     * e.g. scrolling from one short video to the next, and restarts once it doesn't.
     */
    async reset() {
        const seq = ++this.#resetSeq
        const { url, isWhite } = locationWatcher
        const rules = isWhite ? [] : await trySendMsg2Runtime('limit.list', { effective: true, url }) ?? []
        // Discard the outdated response
        if (seq !== this.#resetSeq) return

        const scopeKey = visitScopeKey(rules)
        if (url !== this.#rulesUrl && scopeKey !== this.#scopeKey) {
            this.#mills = 0
            this.#delayCount = 0
            this.#notify()
        }
        this.#rulesUrl = url
        this.#scopeKey = scopeKey
        this.#rules = rules

        // Keep the reasons still hit, so the modal doesn't flicker when moving within a limited visit
        const reasons = isWhite ? [] : this.#limitedReasons()
        const stale = this.state.reasons.filter(r => r.type === 'VISIT' && !reasons.some(n => isSameReason(r, n)))
        this.state.remove(...stale)
        this.state.add(...reasons)
    }
}

export default VisitProcessor
