Rails.application.routes.draw do
  get "up" => "rails/health#show", as: :rails_health_check

  # instructor pages
  get "host", to: "pages#host"
  get "edit", to: "pages#edit"
  get "reports", to: "pages#reports"

  # the API the pages call. Paths match the Node version so the page scripts carry over.
  scope "api", defaults: { format: :json } do
    get "me", to: "me#show"
    get "quizzes", to: "quizzes#index"
    get "quiz/:id", to: "quizzes#show"
    put "quiz/:id", to: "quizzes#update"
    delete "quiz/:id", to: "quizzes#destroy"
    post "quiz-check", to: "quizzes#check"
    get "rosters", to: "rosters#index"
    get "roster/:id", to: "rosters#show"
    put "roster/:id", to: "rosters#update"
    delete "roster/:id", to: "rosters#destroy"
    get "reports", to: "reports#index"
    get "students", to: "reports#students"
    get "reports/:id", to: "reports#show"
    get "reports/:id/csv", to: "reports#csv"
    post "reports/:id/review-quiz", to: "reports#review_quiz"
    delete "reports/:id", to: "reports#destroy"
    # public: players and the lobby screen use these
    get "nickname", to: "nicknames#show"
    get "qr.svg", to: "qr#show", format: false
  end
  get "quiz-images/*name", to: "images#show", format: false
end
