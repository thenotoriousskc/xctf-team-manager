import { useAthleticNetPRs } from '../hooks/useAthleticNetPRs.ts'

interface Props {
  athleteName: string
  wrapperClass?: string
}

export function AthleticNetPRs({ athleteName, wrapperClass }: Props) {
  const { prs, athleteId, loading, error } = useAthleticNetPRs(athleteName)

  const individualPrs = prs.filter(pr => !/relay/i.test(pr.event))

  if (loading || error || individualPrs.length === 0) return null

  return (
    <div className={wrapperClass ?? ''}>
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
        Track &amp; Field PRs
      </h3>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        {individualPrs.map((pr, i) => (
          <div key={i} className="flex justify-between text-sm">
            <span className="text-gray-600">{pr.event}</span>
            <span className="font-mono font-medium">{pr.mark}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-400 mt-2">
        via{' '}
        <a
          href={athleteId
            ? `https://www.athletic.net/athlete/${athleteId}/track-and-field`
            : `https://www.athletic.net/search#q=${encodeURIComponent(athleteName)}&sport=tf`}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-gray-600"
        >
          athletic.net
        </a>
      </p>
    </div>
  )
}
