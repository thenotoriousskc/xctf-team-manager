export function LoadingSpinner({ message = 'Loading...' }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
      <div className="w-10 h-10 border-4 border-navy-200 border-t-navy-600 rounded-full animate-spin" />
      <p className="text-navy-600 text-sm">{message}</p>
    </div>
  )
}

export function ErrorDisplay({
  message,
  onRetry,
}: {
  message: string
  onRetry?: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-6">
      <div className="text-4xl">!</div>
      <p className="text-red-600 text-center text-sm">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-4 py-2 bg-navy-600 text-white rounded-lg text-sm active:bg-navy-700"
        >
          Try Again
        </button>
      )}
    </div>
  )
}
