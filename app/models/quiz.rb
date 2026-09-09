# A quiz, stored as the JSON document the editor produces. `slug` is what the
# quiz files used as a file name and what the host and editor pages use as an id.
class Quiz < ApplicationRecord
  SLUG = /\A[A-Za-z0-9_-]{1,60}\z/

  belongs_to :user
  has_many :games, dependent: :nullify

  before_validation { self.title = body["title"].to_s.strip if body.is_a?(Hash) }
  validates :slug, presence: true, format: { with: SLUG, message: "must be letters, digits, dash or underscore" },
                   uniqueness: { scope: :user_id }
  validates :title, presence: true
  validate :body_is_a_valid_quiz

  scope :ordered, -> { order(Arel.sql("LOWER(title)")) }

  # What the quiz list shows. A quiz that no longer validates is still listed, marked.
  def summary
    { "id" => slug, "title" => title, "count" => body["questions"].to_a.length }
  rescue StandardError => e
    { "id" => slug, "title" => "#{slug} (invalid)", "count" => 0, "error" => e.message }
  end

  # The normalised quiz a game plays. Raises Tigerquiz::InvalidQuestion if it cannot be played.
  def playable
    Tigerquiz::QuizDocument.load(body, slug)
  end

  # Pick a slug nobody else of this user has, by appending -2, -3 and so on.
  def self.unique_slug(user, base)
    Tigerquiz::QuizDocument.unique_slug(base) { |candidate| user.quizzes.exists?(slug: candidate) }
  end

  private

  def body_is_a_valid_quiz
    problems = Tigerquiz::QuizDocument.validate(body)["problems"]
    problems.each { |p| errors.add(:body, p) }
  end
end
